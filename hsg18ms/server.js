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
    console.log(`[ALERT DISPATCH] 2FA Failure notification pushed to ntfy.`);
  } catch (err) {
    console.error("Failed to push 2FA failure alert:", err.message);
  }
}

async function setNotehubAppMode(newMode) {
  const projectUid = process.env.NOTEHUB_PROJECT_UID;
  const authToken = process.env.NOTEHUB_AUTH_TOKEN;

  if (!projectUid || !authToken) return false;

  try {
    await axios.put(
      `https://api.notefile.net/v1/projects/${projectUid}/env`,
      { env: { app_mode: newMode } },
      { headers: { 'X-SESSION-TOKEN': authToken } }
    );
    return true;
  } catch (err) {
    console.error("Failed to update Notehub app_mode:", err.message);
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

// Middleware: Validates 6-Digit TOTP and notifies on failure
async function verifyTotpMiddleware(req, res, next) {
  if (!TOTP_SECRET) {
    return res.status(500).send("Server configuration error: TOTP secret missing.");
  }

  const code = req.query.code;

  if (!code) {
    await sendFailedAuthNotification("MISSING_CODE", req.path);
    return res.status(401).send(`
      <div style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h1 style="color: #d32f2f;">401 Unauthorized</h1>
        <p>Missing 6-digit 2FA code. Please append <b>?code=123456</b> to the URL.</p>
      </div>
    `);
  }

  const isValid = authenticator.check(code.trim(), TOTP_SECRET);

  if (!isValid) {
    console.warn(`[UNAUTHORIZED ATTEMPT] Invalid TOTP code tried: ${code}`);
    await sendFailedAuthNotification(code, req.path);

    return res.status(401).send(`
      <div style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h1 style="color: #d32f2f;">401 Unauthorized</h1>
        <p>Invalid or expired 2FA code. A failure push notification has been dispatched.</p>
      </div>
    `);
  }

  next();
}

app.get('/set-mode', verifyTotpMiddleware, async (req, res) => {
  const mode = (req.query.mode || '').toUpperCase();
  if (!['PARKED', 'OWNER', 'BORROWER'].includes(mode)) {
    return res.status(400).send("Invalid mode specified. Use PARKED, OWNER, or BORROWER.");
  }

  const success = await setNotehubAppMode(mode);
  if (success) {
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h1 style="color: #2e7d32;">Mode Successfully Changed to: ${mode}</h1>
        <p>2FA Authenticated. The Cygnet MCU will sync with Notehub shortly.</p>
      </div>
    `);
  } else {
    return res.status(500).send("Failed to update mode in Notehub.");
  }
});

app.get('/verify-2fa', verifyTotpMiddleware, async (req, res) => {
  await sendInboundNoteToMCU({ verified: true });
  return res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 40px;">
      <h1 style="color: #2e7d32;">2FA Disarm Verified!</h1>
      <p>Identity confirmed via Authenticator. Disarm signal sent over cellular.</p>
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
    alertTitle = `📍 GPS LOCK [${mode} MODE]`;
    alertMessage = `System Active.\nGrid: ${lat}, ${lon}`;
    tags = ["satellite"];
  } 
  else if (event === "device_moved") {
    alertTitle = `⚠️ MOVEMENT DETECTED [${mode} MODE]`;
    alertMessage = `Vehicle moving!\nGrid: ${lat}, ${lon}\nYou have 2 minutes to authenticate with your 6-digit code.`;
    priority = "4";
    tags = ["warning", "rotating_light"];
  } 
  else if (event === "vehicle_tilt_warning") {
    const orientation = payload.orientation || "Tilted";
    alertTitle = `🚨 CRITICAL TILT DETECTED`;
    alertMessage = `Vehicle Rollover/Tilt (${orientation})!\nGrid: ${lat}, ${lon}`;
    priority = "5";
    tags = ["car", "alert"];
  }
  else if (event === "geofence_breach") {
    const dist = payload.distance || 0;
    alertTitle = `⛔ 40-MILE GEOFENCE BREACH`;
    alertMessage = `Borrower exceeded limit!\nDistance: ${dist} mi\nGrid: ${lat}, ${lon}`;
    priority = "5";
    tags = ["no_entry_sign", "siren"];
  }
  else if (event === "security_breach") {
    alertTitle = `⛔ SECURITY BREACH`;
    alertMessage = `2FA Unverified within 2 mins! Vehicle moving.\nGrid: ${lat}, ${lon}`;
    priority = "5";
    tags = ["siren"];
  } 
  else if (event === "tracking_update") {
    alertTitle = `📡 TRACKING UPDATE`;
    alertMessage = `Updated Grid: ${lat}, ${lon}`;
    tags = ["compass"];
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
        'Actions': `view, Authenticate 2FA, ${secureDisarmUrl}`
      }
    });

    return res.status(200).json({ status: "success", event: event });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Secure TOTP 2FA Service active on port ${PORT}`));