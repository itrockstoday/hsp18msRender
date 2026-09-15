import express from 'express';
import axios from 'axios';
import { authenticator } from 'otplib';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

authenticator.options = { window: 1 };

const NTFY_TOPIC = process.env.NTFY_TOPIC_NAME || 'hspg18ms_alerts_3486';

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
    console.error("Error parsing USER_REGISTRY_JSON:", err.message);
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
      `Unauthorized 2FA attempt on endpoint '${endpointName}'. Code submitted: '${attemptedCode || 'None'}'`, 
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
    return res.status(403).json({ status: "error", message: "Borrower accounts restricted from OWNER mode." });
  }

  const success = await setNotehubConfig(targetMode, lat, lon);
  if (success) {
    await sendInboundNoteToMCU({ verified: true, mode: targetMode, user: user.name });

    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
      `2FA Verified for ${user.name} (${user.role}). Mode set to ${targetMode}.`, 
      { headers: { 'Title': `✅ MODE UPDATED BY ${user.name.toUpperCase()}`, 'Priority': '3', 'Tags': 'gear,white_check_mark' } }
    );

    return res.json({ status: "success", mode: targetMode, user: user.name });
  } else {
    return res.status(500).json({ status: "error", message: "Failed to update configuration in Notehub." });
  }
});

app.all('/verify-2fa', verifyTotpMiddleware, async (req, res) => {
  const user = req.user;
  let resolvedMode = user.role === "BORROWER" ? "BORROWER" : "OWNER";
  
  await setNotehubConfig(resolvedMode);
  await sendInboundNoteToMCU({ verified: true, user: user.name, mode: resolvedMode });

  await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, 
    `Disarm verified for ${user.name} (${user.role} Group). Mode set to ${resolvedMode}. Alarms cleared.`, 
    { headers: { 'Title': `✅ DISARMED BY ${user.name.toUpperCase()}`, 'Priority': '3', 'Tags': 'shield,white_check_mark' } }
  );

  return res.json({ status: "success", user: user.name, mode: resolvedMode });
});

app.post('/notehub-webhook', async (req, res) => {
  console.log("Inbound Notehub Event Received:", JSON.stringify(req.body));
  
  // Robust nested extraction for Notehub payload format
  const payloadBody = req.body.body || req.body;
  const event = payloadBody.event || req.body.event;

  if (!event) {
    console.log("No valid event string found in payload body.");
    return res.status(200).json({ status: "ignored_no_event" });
  }

  const rawLat = req.body.best_lat || req.body.where_lat || req.body.lat || payloadBody.lat || 0;
  const rawLon = req.body.best_lon || req.body.where_lon || req.body.lon || payloadBody.lon || 0;
  
  const latStr = rawLat !== 0 ? rawLat.toFixed(6) : "No Lock Yet";
  const lonStr = rawLon !== 0 ? rawLon.toFixed(6) : "No Lock Yet";
  const mode = payloadBody.mode || "PARKED";
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://hsp18msrender.onrender.com';

  let alertTitle = "";
  let alertMessage = "";
  let priority = 3;
  let tags = [];
  let includeButtons = true;

  if (event === "boot_location_captured") {
    alertTitle = `🅿️ MOTORCYCLE ONLINE [PARKED MODE]`;
    alertMessage = `Blues Feather Kit Reset / Boot Detected.\nMode: PARKED`;
    priority = 3;
    tags = ["motorcycle", "round_pushpin"];
    includeButtons = false;
  } 
  else if (event === "parked_tilt_moved") {
    const baseline = payloadBody.baseline || "Unknown";
    const current = payloadBody.current || "Unknown";
    alertTitle = `⚠️ MOVEMENT DETECTED: TILT CHANGED`;
    alertMessage = `Motorcycle shifted from parked position!\nBaseline: ${baseline}\nCurrent: ${current}\nStatus: Awaiting 2FA (2 min window)`;
    priority = 4;
    tags = ["warning", "rotating_light"];
  } 
  else if (event === "security_breach") {
    alertTitle = `⛔ 2FA SECURITY BREACH`;
    alertMessage = `SECURITY BREACH TRIGGERED!\nNo 2FA PIN provided within 2 minutes.\nAcquiring GPS tracking coordinates...`;
    priority = 5;
    tags = ["siren", "no_entry"];
  } 
  else if (event === "tracking_update") {
    alertTitle = `📡 GPS TRACKING UPDATE`;
    alertMessage = `Stolen Vehicle Tracking Update\nMode: ${mode}\nLat: ${latStr}\nLon: ${lonStr}\nMap: https://maps.google.com/?q=${rawLat},${rawLon}`;
    priority = 4;
    tags = ["compass", "satellite"];
  } 
  else if (event === "geofence_warning_30mi") {
    alertTitle = `⚠️ 30-MILE GEOFENCE WARNING`;
    alertMessage = `Borrower Notice: ${payloadBody.distance ? payloadBody.distance.toFixed(1) : 0} miles from Home Location.`;
    priority = 3;
    tags = ["warning", "compass"];
  }
  else if (event === "geofence_breach_40mi") {
    alertTitle = `⛔ 40-MILE GEOFENCE BREACH`;
    alertMessage = `CRITICAL: Borrower exceeded 40-mile limit!\nDistance: ${payloadBody.distance ? payloadBody.distance.toFixed(1) : 0} miles.`;
    priority = 5;
    tags = ["no_entry_sign", "siren"];
  }
  else {
    return res.status(200).json({ status: "unhandled_event_type" });
  }

  const ntfyPayload = {
    topic: NTFY_TOPIC,
    title: alertTitle,
    message: alertMessage,
    priority: priority,
    tags: tags
  };

  if (includeButtons) {
    ntfyPayload.actions = [
      {
        action: "http",
        label: "🔑 Disarm System",
        url: `${externalUrl}/verify-2fa`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "code=$input"
      },
      {
        action: "http",
        label: "🅿️ Set PARKED",
        url: `${externalUrl}/set-mode?mode=PARKED`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "code=$input"
      },
      {
        action: "http",
        label: "🔓 Set OWNER",
        url: `${externalUrl}/set-mode?mode=OWNER`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "code=$input"
      },
      {
        action: "http",
        label: "🚲 Set BORROWER",
        url: `${externalUrl}/set-mode?mode=BORROWER`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "code=$input"
      }
    ];
  }

  try {
    await axios.post('https://ntfy.sh', ntfyPayload);
    console.log(`ntfy notification pushed successfully for event: ${event}`);
    return res.status(200).json({ status: "success", event: event });
  } catch (error) {
    console.error("ntfy dispatch error (Retrying without buttons):", error.message);
    delete ntfyPayload.actions;
    try {
      await axios.post('https://ntfy.sh', ntfyPayload);
      console.log(`Fallback ntfy push succeeded for event: ${event}`);
      return res.status(200).json({ status: "success_fallback", event: event });
    } catch (fallbackError) {
      console.error("Fallback ntfy dispatch failed:", fallbackError.message);
      return res.status(500).json({ status: "error", message: fallbackError.message });
    }
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HSG18MS Webhook Listener running on port ${PORT}`));