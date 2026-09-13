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

  req.user = authenticatedUser;
  next();
}

// Endpoint: Set mode with 2FA verification
app.all('/set-mode', verifyTotpMiddleware, async (req, res) => {
  const targetMode = (req.query.mode || req.body.mode || '').toUpperCase();
  const lat = req.query.lat || req.body.lat ? parseFloat(req.query.lat || req.body.lat) : null;
  const lon = req.query.lon || req.body.lon ? parseFloat(req.query.lon || req.body.lon) : null;
  const user = req.user;

  if (!['PARKED', 'OWNER', 'BORROWER'].includes(targetMode)) {
    return res.status(400).json({ status: "error", message: "Invalid mode. Use PARKED, OWNER, or BORROWER." });
  }

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
      `2FA Verified for ${user.name} (${user.role}). Mode set to ${targetMode}. System updated.`, 
      { headers: { 'Title': `✅ MODE UPDATED BY ${user.name.toUpperCase()}`, 'Priority': '3', 'Tags': 'gear,white_check_mark' } }
    );

    return res.json({ status: "success", mode: targetMode, user: user.name, message: `System mode updated to ${targetMode} by ${user.name}` });
  } else {
    return res.status(500).json({ status: "error", message: "Failed to update configuration in Notehub." });
  }
});

// Endpoint: Disarm with 2FA verification
app.all('/verify-2fa', verifyTotpMiddleware, async (req, res) => {
  const user = req.user;
  let resolvedMode = user.role === "BORROWER" ? "BORROWER" : "OWNER";
  
  await setNotehubConfig(resolvedMode);
  await sendInboundNoteToMCU({ verified: true, user: user.name, mode: resolvedMode });

  await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
    `Disarm verified for ${user.name} (${user.role} Group). Mode automatically updated to ${resolvedMode}. Alarms cleared.`, 
    { headers: { 'Title': `✅ DISARMED BY ${user.name.toUpperCase()}`, 'Priority': '3', 'Tags': 'shield,white_check_mark' } }
  );

  return res.json({ status: "success", user: user.name, mode: resolvedMode, message: "Disarm verified and dispatched to MCU." });
});

// Main Webhook Receiver from Notehub
app.post('/notehub-webhook', async (req, res) => {
  const payload = req.body.body || req.body;
  const event = payload.event;

  if (!event) return res.status(200).json({ status: "ignored_internal_system_note" });

  const rawLat = payload.lat || 0;
  const rawLon = payload.lon || 0;
  
  // Format to high-precision coordinate strings
  const latStr = rawLat !== 0 ? rawLat.toFixed(8) : "No GPS Lock";
  const lonStr = rawLon !== 0 ? rawLon.toFixed(8) : "No GPS Lock";
  const mode = payload.mode || "PARKED";
  const mapsUrl = rawLat !== 0 ? `https://maps.google.com/?q=${rawLat},${rawLon}` : `https://ntfy.sh/${NTFY_TOPIC}`;
  
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://your-render-app.onrender.com';

  let alertTitle = "";
  let alertMessage = "";
  let priority = 3;
  let tags = [];
  let includeButtons = true;

  // 1. BOOT / STARTUP NOTIFICATION (NO 2FA REQUIRED)
  if (event === "boot_location_captured") {
    alertTitle = `🅿️ MOTORCYCLE ONLINE [PARKED MODE]`;
    alertMessage = `System powered on and active.\nMode: PARKED\nGPS Coordinates:\nLatitude: ${latStr}\nLongitude: ${lonStr}`;
    priority = 3;
    tags = ["motorcycle", "round_pushpin"];
    includeButtons = false; // No 2FA buttons required for basic startup push
  } 
  else if (event === "parked_tilt_moved") {
    const baseline = payload.baseline || "Unknown";
    const current = payload.current || "Unknown";
    alertTitle = `⚠️ MOVEMENT DETECTED: TILT CHANGED`;
    alertMessage = `Motorcycle shifted from parked position!\nBaseline: ${baseline} ➔ Current: ${current}\nLocation: ${latStr}, ${lonStr}\nTap button below to enter 6-digit 2FA PIN:`;
    priority = 4;
    tags = ["warning", "rotating_light"];
  } 
  else if (event === "geofence_warning_30mi") {
    const dist = payload.distance || 0;
    alertTitle = `⚠️ 30-MILE GEOFENCE WARNING`;
    alertMessage = `Borrower Notice: ${dist.toFixed(1)} miles from Home Location.\nWithin 10 miles of limit (40-mile max).`;
    priority = 3;
    tags = ["warning", "compass"];
  }
  else if (event === "geofence_breach_40mi") {
    const dist = payload.distance || 0;
    alertTitle = `⛔ 40-MILE GEOFENCE BREACH (OWNER ALERT)`;
    alertMessage = `CRITICAL: Borrower exceeded 40-mile limit!\nDistance: ${dist.toFixed(1)} miles.\nLocation: ${latStr}, ${lonStr}`;
    priority = 5;
    tags = ["no_entry_sign", "siren"];
  }
  else if (event === "security_breach") {
    alertTitle = `⛔ 2FA SECURITY BREACH`;
    alertMessage = `SECURITY BREACH TRIGGERED!\nNo 2FA PIN provided within 2 minutes.\nEnter 2FA PIN below to clear breach or change mode.\nLocation: ${latStr}, ${lonStr}`;
    priority = 5;
    tags = ["siren", "no_entry"];
  } 
  else if (event === "tracking_update") {
    alertTitle = `📡 GPS TRACKING UPDATE`;
    alertMessage = `Active GPS Tracking Fix Established!\nMode: ${mode}\nLocation: ${latStr}, ${lonStr}`;
    priority = 3;
    tags = ["compass", "satellite"];
  } 
  else {
    return res.status(200).json({ status: "unhandled_event_type" });
  }

  try {
    const ntfyPayload = {
      topic: NTFY_TOPIC,
      title: alertTitle,
      message: alertMessage,
      priority: priority,
      tags: tags,
      click: mapsUrl
    };

    // Standard ntfy Action Buttons Header Format (Works on iOS, Android, and Web)
    if (includeButtons) {
      ntfyPayload.actions = [
        {
          action: "http",
          label: "🔑 Disarm",
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
    }

    await axios.post('https://ntfy.sh', ntfyPayload);
    return res.status(200).json({ status: "success", event: event });
  } catch (error) {
    console.error("ntfy dispatch error:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HSG18MS Server active on port ${PORT}`));