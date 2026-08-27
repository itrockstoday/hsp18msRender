const express = require('express');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
app.use(express.json());

authenticator.options = { window: 1 };

const NTFY_TOPIC = process.env.NTFY_TOPIC_NAME || 'hspg18ms_alerts_3486';
const TOTP_SECRET = process.env.TOTP_SECRET;

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

async function verifyTotpMiddleware(req, res, next) {
  if (!TOTP_SECRET) return res.status(500).send("Server configuration error: TOTP secret missing.");

  const code = req.query.code;
  if (!code) {
    await sendFailedAuthNotification("MISSING_CODE", req.path);
    return res.status(401).send(`
      <div style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h1 style="color: #d32f2f;">401 Unauthorized</h1>
        <p>Missing 6-digit 2FA code. Append <b>?code=123456</b> to your request.</p>
      </div>
    `);
  }

  const isValid = authenticator.check(code.trim(), TOTP_SECRET);
  if (!isValid) {
    await sendFailedAuthNotification(code, req.path);
    return res.status(401).send(`
      <div style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h1 style="color: #d32f2f;">401 Unauthorized</h1>
        <p>Invalid or expired 2FA code.</p>
      </div>
    `);
  }

  next();
}

app.get('/set-mode', verifyTotpMiddleware, async (req, res) => {
  const mode = (req.query.mode || '').toUpperCase();
  const lat = req.query.lat ? parseFloat(req.query.lat) : null;
  const lon = req.query.lon ? parseFloat(req.query.lon) : null;

  if (!['PARKED', 'OWNER', 'BORROWER'].includes(mode)) {
    return res.status(400).send("Invalid mode specified. Use PARKED, OWNER, or BORROWER.");
  }

  const success = await setNotehubConfig(mode, lat, lon);
  if (success) {
    let locMsg = (mode === 'BORROWER' && lat && lon) 
      ? `<p>Borrower Home Location set to: <b>${lat}, ${lon}</b></p>` 
      : (mode === 'BORROWER') ? `<p>Borrower Home Location will automatically pin to current device location.</p>` : '';

    return res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h1 style="color: #2e7d32;">Mode Successfully Changed to: ${mode}</h1>
        ${locMsg}
        <p>2FA Authenticated. The Cygnet MCU will sync with Notehub shortly.</p>
      </div>
    `);
  } else {
    return res.status(500).send("Failed to update configuration in Notehub.");
  }
});

app.get('/verify-2fa', verifyTotpMiddleware, async (req, res) => {
  await sendInboundNoteToMCU({ verified: true });
  return res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 40px;">
      <h1 style="color: #2e7d32;">2FA Disarm Verified!</h1>
      <p>Identity confirmed. Tilt / Movement alarm disarmed via cellular.</p>
    </div>
  `);
});

app.post('/notehub-webhook', async (req, res) => {
  const payload = req.body.body || req.body;
  const event = payload.event;

  if (!event) return res.status(200).json({ status: "ignored_internal_system_note" });

  const lat = (payload.lat || 0).toFixed(5);
  const lon = (payload.lon || 0).toFixed(5);
  const mode = payload.mode || "PARKED";
  const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
  
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://your-render-app.onrender.com';

  let alertTitle = "";
  let alertMessage = "";
  let priority = "3";
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
    alertMessage = `Bike shifted from parked position!\nBaseline: ${baseline} ➔ Current: ${current}\nGrid: ${lat}, ${lon}\n2FA PIN required within 2 minutes!`;
    priority = "4";
    tags = ["warning", "rotating_light"];
  } 
  else if (event === "geofence_warning_30mi") {
    const dist = payload.distance || 0;
    alertTitle = `⚠️ 30-MILE GEOFENCE WARNING`;
    alertMessage = `Borrower Notice: ${dist.toFixed(1)} miles from Home Location.\nWithin 10 miles of max allowed area (40-mile limit).`;
    priority = "3";
    tags = ["warning", "compass"];
  }
  else if (event === "geofence_breach_40mi") {
    const dist = payload.distance || 0;
    alertTitle = `⛔ 40-MILE GEOFENCE BREACH (OWNER ALERT)`;
    alertMessage = `CRITICAL: Borrower exceeded 40-mile limit!\nDistance: ${dist.toFixed(1)} miles.\nGrid: ${lat}, ${lon}`;
    priority = "5";
    tags = ["no_entry_sign", "siren"];
  }
  else if (event === "security_breach") {
    alertTitle = `⛔ 2FA SECURITY BREACH`;
    alertMessage = `SECURITY BREACH HAS BEEN TRIGGERED!\nNo 2FA PIN provided within 2 minutes.\nEnter 2FA PIN to stop security breach notifications.\nGrid: ${lat}, ${lon}`;
    priority = "5";
    tags = ["siren", "no_entry"];
  } 
  else if (event === "tracking_update") {
    alertTitle = `📡 SECURITY BREACH: GPS UPDATE`;
    alertMessage = `ALERT: 2FA Security Breach Active!\nUpdated Grid: ${lat}, ${lon}\nEnter 2FA PIN to stop notifications.`;
    priority = "5";
    tags = ["compass", "warning"];
  } 
  else {
    return res.status(200).json({ status: "unhandled_event_type" });
  }

  try {
    const secureDisarmUrl = `${externalUrl}/verify-2fa`;

    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, alertMessage, {
      headers: {
        'Title': alertTitle,
        'Priority': priority,
        'Tags': tags.join(','),
        'Click': mapsUrl,
        'Actions': `view, Enter 2FA PIN, ${secureDisarmUrl}`
      }
    });

    return res.status(200).json({ status: "success", event: event });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Secure TOTP 2FA Service active on port ${PORT}`));