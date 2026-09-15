const express = require('express');
const axios = require('axios');
const speakEasy = require('speakeasy');

const app = express();
app.use(express.json());

// --- CONFIGURATION & ENV VARIABLES ---
const PORT = process.env.PORT || 3000;
const TOTP_SECRET = process.env.TOTP_SECRET || 'BASE32_SECRET_KEY_HERE';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'https://ntfy.sh/your_custom_topic_123';
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID || 'app:xxxx-xxxx-xxxx';
const NOTEHUB_DEVICE_UID = process.env.NOTEHUB_DEVICE_UID || 'dev:xxxx-xxxx-xxxx';
const NOTEHUB_AUTH_TOKEN = process.env.NOTEHUB_AUTH_TOKEN || 'your_notehub_token';

// In-memory state tracking
let systemState = {
  currentMode: 'PARKED',
  is2FAArmed: true,
  lastUpdated: new Date().toISOString()
};

// --- HELPER FUNCTIONS ---

// Verify 6-digit TOTP token
function verifyTOTP(token) {
  return speakEasy.totp.verify({
    secret: TOTP_SECRET,
    encoding: 'base32',
    token: token,
    window: 1 // Allows 30-second time drift compensation
  });
}

// Send push notifications via ntfy
async function sendNtfyAlert(title, message, includeButton = true) {
  try {
    const payload = {
      topic: NTFY_TOPIC.replace('https://ntfy.sh/', ''),
      title: title,
      message: message,
      priority: 4
    };

    if (includeButton) {
      payload.actions = [
        {
          action: 'view',
          label: '🌐 Open Control Panel',
          url: 'http://localhost:8080'
        }
      ];
    }

    await axios.post('https://ntfy.sh', payload);
    console.log(`[NTFY] Notification sent: ${title}`);
  } catch (err) {
    console.error('[NTFY ERROR]:', err.message);
  }
}

// Route commands down to the Blues Feather kit via Notehub API
async function sendNotehubCommand(cmd, value) {
  if (!NOTEHUB_PROJECT_UID || !NOTEHUB_DEVICE_UID) {
    console.log(`[MOCK NOTEHUB] Dispatched ${cmd} = ${value}`);
    return true;
  }

  const url = `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${NOTEHUB_DEVICE_UID}/notes`;
  try {
    await axios.post(
      url,
      {
        file: 'cmd.qi',
        note: {
          cmd: cmd,
          value: value,
          timestamp: Math.floor(Date.now() / 1000)
        }
      },
      {
        headers: {
          'X-SESSION-TOKEN': NOTEHUB_AUTH_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`[NOTEHUB] Note written to device: ${cmd}=${value}`);
    return true;
  } catch (err) {
    console.error('[NOTEHUB ERROR]:', err.response?.data || err.message);
    throw new Error('Failed to update Blues Feather Notehub queue.');
  }
}

// --- EXPRESS ENDPOINTS ---

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Online', systemState });
});

// Endpoint 1: Verify 2FA TOTP Code Only
app.post('/verify-2fa', async (req, res) => {
  const { code } = req.body;

  if (!code || !verifyTOTP(code)) {
    return res.status(401).json({ status: 'error', message: 'Invalid 2FA Code' });
  }

  systemState.is2FAArmed = false;
  systemState.lastUpdated = new Date().toISOString();

  await sendNotehubCommand('disarm_2fa', true);
  await sendNtfyAlert('🔑 2FA Disarmed', 'Security verification succeeded. System disarmed.', false);

  res.json({ status: 'success', message: '2FA Successfully Verified & Disarmed' });
});

// Endpoint 2: Set Mode (OWNER, BORROWER, PARKED)
app.post('/set-mode', async (req, res) => {
  const { code } = req.body;
  const mode = req.query.mode ? req.query.mode.toUpperCase() : null;

  const validModes = ['OWNER', 'BORROWER', 'PARKED'];
  if (!mode || !validModes.includes(mode)) {
    return res.status(400).json({ status: 'error', message: 'Invalid mode requested.' });
  }

  if (!code || !verifyTOTP(code)) {
    return res.status(401).json({ status: 'error', message: 'Invalid or missing 2FA Code.' });
  }

  try {
    systemState.currentMode = mode;
    systemState.lastUpdated = new Date().toISOString();

    await sendNotehubCommand('set_mode', mode);
    await sendNtfyAlert(`🔄 Mode Changed: ${mode}`, `System successfully updated to ${mode} mode.`, false);

    res.json({
      status: 'success',
      message: `Mode changed to ${mode}`,
      currentState: systemState
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Endpoint 3: Webhook trigger from Blues Feather kit to issue 2FA alert
app.post('/trigger-2fa-request', async (req, res) => {
  systemState.is2FAArmed = true;
  await sendNtfyAlert('🚨 2FA Verification Required', 'Security event detected. Open local server panel to authenticate.');
  res.json({ status: 'success', message: '2FA Request Broadcasted' });
});

// --- SERVER INITIALIZATION ---
app.listen(PORT, () => {
  console.log(`Render backend running on port ${PORT}`);
});