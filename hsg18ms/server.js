const express = require('express');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

authenticator.options = { window: 1 };

const NTFY_TOPIC = process.env.NTFY_TOPIC_NAME || 'hspg18ms_alerts_3486';

/* 
  USER REGISTRY CONFIGURATION (Environment Variable: USER_REGISTRY_JSON)
  Expected JSON structure inside Render Environment Variables:
  [
    { "name": "Primary Owner", "secret": "JBSWY3DPEHPK3PXP", "role": "OWNER" },
    { "name": "Brother", "secret": "HXDMVJECJJW9833D", "role": "OWNER" },
    { "name": "Friend Alex", "secret": "KRSXG5CTMVRXEZLU", "role": "BORROWER" },
    { "name": "Friend Sam", "secret": "MZXXE5DFOR2XEZLU", "role": "BORROWER" }
  ]
*/
function getUsers() {
  const jsonStr = process.env.USER_REGISTRY_JSON;
  if (!jsonStr) {
    // Fallback single-user configuration if USER_REGISTRY_JSON is not yet set
    const fallbackSecret = process.env.TOTP_SECRET;
    if (fallbackSecret) {
      return [{ name: "Default Owner", secret: fallbackSecret, role: "OWNER" }];
    }
    return [];
  }
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Error parsing USER_REGISTRY_JSON environment variable:", err.message);
    return [];
  }
}

// Authenticates TOTP code against registered users and returns user object or null
function authenticateUser(code) {
  if (!code) return null;
  const users = getUsers();
  for (const user of users) {
    if (user.secret && authenticator.check(code, user.secret)) {
      return user;
    }
  }
  return null;
}

// Helper: Notify admin of failed TOTP attempts
async function sendFailedAuthNotification(attemptedCode, endpointName) {
  try {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
      `Unauthorized or invalid 2FA attempt on endpoint '${endpointName}'. Code submitted: '${attemptedCode || 'None'}'`, 
      {
        headers: {
          'Title': '🚨 2FA VERIFICATION FAILED',
          'Priority': '5',
          'Tags': 'no_entry,warning'
        }
      }
    );
  } catch (err) {
    console.error("Failed to push 2FA failure alert:", err.message);
  }
}

// Helper: Update Notehub environment variables
async function setNotehubConfig(newMode, customLat = null, customLon = null) {
  const projectUid = process.env.NOTEHUB_PROJECT_UID;
  const authToken = process.env.NOTEHUB_AUTH_TOKEN;

  if (!projectUid || !authToken) return false;

  const envPayload = { app_mode: newMode };
  if (customLat && customLon) {
    envPayload.borrower_home_lat = customLat.toString();
    envPayload.borrower_home_lon = customLon.toString();
  }

  try {
    await axios.put(
      `https://api.notefile.net/v1/projects/${projectUid}/env`,
      { env: envPayload },
      { headers: { 'X-SESSION-TOKEN': authToken } }
    );
    return true;
  } catch (err) {
    console.error("Failed to update Notehub configuration:", err.message);
    return false;
  }
}

// Helper: Post disarm/command note directly to device inbound queue (inbound.qi)
async function sendInboundNoteToMCU(bodyData) {
  const projectUid = process.env.NOTEHUB_PROJECT_UID;
  const deviceUid = process.env.NOTEHUB_DEVICE_UID;
  const authToken = process.env.NOTEHUB_AUTH_TOKEN;

  if (!projectUid || !deviceUid || !authToken) return;

  try {
    await axios.post(
      `https://api.notefile.net/v1/projects/${projectUid}/devices/${deviceUid}/notes`,
      { file: "inbound.qi", body: bodyData },
      { headers: { 'X-SESSION-TOKEN': authToken } }
    );
  } catch (err) {
    console.error("Failed to post note to Notehub inbound queue:", err.message);
  }
}

function extractTotpCode(req) {
  if (req.query && req.query.code) return req.query.code.trim();
  if (req.body && req.body.code) return req.body.code.trim();
  return null;
}

// --------------------------------------------------------------------------
// Multi-User TOTP Authentication Middleware
// --------------------------------------------------------------------------
async function verifyTotpMiddleware(req, res, next) {
  const code = extractTotpCode(req);
  if (!code) {
    await sendFailedAuthNotification("MISSING_CODE", req.path);
    return res.status(401).json({ status: "error", message: "Missing 6-digit TOTP code." });
  }

  const authenticatedUser = authenticateUser(code);
  if (!authenticatedUser) {
    await sendFailedAuthNotification(code, req.path);
    return res.status(401).json({ status: "error", message: `Invalid or expired 2FA code: ${code}` });
  }

  // Attach authenticated user identity to request object
  req.user = authenticatedUser;
  next();
}

// Endpoint: Mode change requested via ntfy action or web request
app.all('/set-mode', verifyTotpMiddleware, async (req, res) => {
  const targetMode = (req.query.mode || req.body.mode || '').toUpperCase();
  const lat = req.query.lat || req.body.lat ? parseFloat(req.query.lat || req.body.lat) : null;
  const lon = req.query.lon || req.body.lon ? parseFloat(req.query.lon || req.body.lon) : null;
  const user = req.user;

  if (!['PARKED', 'OWNER', 'BORROWER'].includes(targetMode)) {
    return res.status(400).json({ status: "error", message: "Invalid mode. Use PARKED, OWNER, or BORROWER." });
  }

  // Role Permission Enforcement: Borrowers cannot set OWNER mode
  if (user.role === "BORROWER" && targetMode === "OWNER") {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
      `Permission Denied: User ${user.name} (Borrower Group) attempted to switch system to OWNER mode.`, 
      { headers: { 'Title': '⛔ ACCESS DENIED', 'Priority': '4', 'Tags': 'no_entry' } }
    );
    return res.status(403).json({ status: "error", message: "Borrower accounts are restricted from selecting OWNER mode." });
  }

  const success = await setNotehubConfig(targetMode, lat, lon);
  if (success) {
    await sendInboundNoteToMCU({ verified: true, mode: targetMode, user: user.name });

    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
      `2FA Verified for ${user.name} (${user.role}). Mode set to ${targetMode}. System disarmed.`, 
      { headers: { 'Title': `✅ MODE UPDATED BY ${user.name.toUpperCase()}`, 'Priority': '3', 'Tags': 'gear,white_check_mark' } }
    );

    return res.json({ status: "success", mode: targetMode, user: user.name, message: `System mode updated to ${targetMode} by ${user.name}` });
  } else {
    return res.status(500).json({ status: "error", message: "Failed to update configuration in Notehub." });
  }
});

// Endpoint: General 2FA Disarm signal
app.all('/verify-2fa', verifyTotpMiddleware, async (req, res) => {
  const user = req.user;
  
  // If a borrower disarms the alarm, enforce BORROWER mode by default
  let resolvedMode = user.role === "BORROWER" ? "BORROWER" : "OWNER";
  
  await setNotehubConfig(resolvedMode);
  await sendInboundNoteToMCU({ verified: true, user: user.name, mode: resolvedMode });

  await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
    `Disarm verified for ${user.name} (${user.role} Group). Mode automatically updated to ${resolvedMode}. Alarms cleared.`, 
    { headers: { 'Title': `✅ DISARMED BY ${user.name.toUpperCase()}`, 'Priority': '3', 'Tags': 'shield,white_check_mark' } }
  );

  return res.json({ status: "success", user: user.name, mode: resolvedMode, message: "Disarm verified and dispatched to MCU." });
});

// Main Webhook for Notehub Outbound Alerts
app.post('/notehub-webhook', async (req, res) => {
  const payload = req.body.body || req.body;
  const event = payload.event;

  if (!event) return res.status(200).json({ status: "ignored_internal_system_note" });

  const lat = (payload.lat || 0).toFixed(6);
  const lon = (payload.lon || 0).toFixed(6);
  const mode = payload.mode || "PARKED";
  const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
  
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://your-render-app.onrender.com';

  let alertTitle = "";
  let alertMessage = "";
  let priority = 3;
  let tags = [];

  if (event === "boot_location_captured") {
    alertTitle = `📍 SYSTEM POWERED UP [${mode} MODE]`;
    alertMessage = `System Online (Default: PARKED Mode).\nGrid: ${lat}, ${lon}`;
    tags = ["satellite"];
  } 
  else if (event === "parked_tilt_moved") {
    const baseline = payload.baseline || "Unknown";
    const current = payload.current || "Unknown";
    alertTitle = `⚠️ MOVEMENT DETECTED: TILT CHANGED`;
    alertMessage = `Bike shifted from parked position!\nBaseline: ${baseline} ➔ Current: ${current}\nGrid: ${lat}, ${lon}\nEnter your 6-digit 2FA pin below to disarm:`;
    priority = 4;
    tags = ["warning", "rotating_light"];
  } 
  else if (event === "geofence_warning_30mi") {
    const dist = payload.distance || 0;
    alertTitle = `⚠️ 30-MILE GEOFENCE WARNING`;
    alertMessage = `Borrower Notice: ${dist.toFixed(1)} miles from Home Location.\nWithin 10 miles of max allowed area (40-mile limit).`;
    priority = 3;
    tags = ["warning", "compass"];
  }
  else if (event === "geofence_breach_40mi") {
    const dist = payload.distance || 0;
    alertTitle = `⛔ 40-MILE GEOFENCE BREACH (OWNER ALERT)`;
    alertMessage = `CRITICAL: Borrower exceeded 40-mile limit!\nDistance: ${dist.toFixed(1)} miles.\nGrid: ${lat}, ${lon}`;
    priority = 5;
    tags = ["no_entry_sign", "siren"];
  }
  else if (event === "security_breach") {
    alertTitle = `⛔ 2FA SECURITY BREACH`;
    alertMessage = `SECURITY BREACH HAS BEEN TRIGGERED!\nNo 2FA PIN provided within 2 minutes.\nEnter 2FA PIN below to clear breach or switch modes.\nGrid: ${lat}, ${lon}`;
    priority = 5;
    tags = ["siren", "no_entry"];
  } 
  else if (event === "tracking_update") {
    alertTitle = `📡 GPS TRACKING UPDATE`;
    alertMessage = `Active GPS Tracking Fix Established!\nMode: ${mode}\nGrid: ${lat}, ${lon}`;
    priority = 3;
    tags = ["compass", "satellite"];
  } 
  else {
    return res.status(200).json({ status: "unhandled_event_type" });
  }

  try {
    const actions = [
      {
        action: "http",
        label: "🔑 Disarm Alarm",
        url: `${externalUrl}/verify-2fa`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "$input" })
      },
      {
        action: "http",
        label: "🅿️ Set PARKED",
        url: `${externalUrl}/set-mode`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "PARKED", code: "$input" })
      },
      {
        action: "http",
        label: "🔓 Set OWNER",
        url: `${externalUrl}/set-mode`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "OWNER", code: "$input" })
      },
      {
        action: "http",
        label: "🚲 Set BORROWER",
        url: `${externalUrl}/set-mode`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "BORROWER", code: "$input" })
      }
    ];

    await axios.post('https://ntfy.sh', {
      topic: NTFY_TOPIC,
      title: alertTitle,
      message: alertMessage,
      priority: priority,
      tags: tags,
      click: mapsUrl,
      actions: actions
    });

    return res.status(200).json({ status: "success", event: event });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HSG18MS Multi-User Server running on port ${PORT}`));