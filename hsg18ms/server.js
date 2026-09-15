const express = require('express');
const axios = require('axios');

const app = express();

// 1. Enable CORS for iSH Shell / iPhone local server (http://localhost:8080)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Server Configuration & ntfy Topic
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'hspg18ms_alerts_3486';

/**
 * Sends Push Notifications to ntfy.sh
 * Priority 4 with Action Button linking back to your iPhone Control Panel
 */
async function sendNtfyAlert(title, message, includeButton = true) {
  try {
    const rawTopic = NTFY_TOPIC.replace(/^https?:\/\/ntfy\.sh\//i, '').trim();

    const payload = {
      topic: rawTopic,
      title: title,
      message: message,
      priority: 4
    };

    if (includeButton) {
      payload.actions = [
        {
          action: 'view',
          label: '🌐 Open iPhone Control Panel',
          url: 'http://localhost:8080'
        }
      ];
    }

    const response = await axios.post('https://ntfy.sh', payload, {
      headers: { 
        'Content-Type': 'application/json' 
      }
    });

    console.log(`[NTFY SUCCESS] Dispatched to topic "${rawTopic}": "${title}" (Status: ${response.status})`);
  } catch (err) {
    console.error('[NTFY ERROR] Dispatch failed:', err.response?.data || err.message);

    if (includeButton) {
      console.log('[NTFY RETRY] Retrying without action button...');
      await sendNtfyAlert(title, message, false);
    }
  }
}

/**
 * Handle Inbound Events from Notehub (alerts.qo and _track.qo)
 */
async function handleNotehubEvent(req, res) {
  const event = req.body;
  console.log(`[NOTEHUB EVENT] Path=${req.path}, File=${event.file}, Event=${event.body?.event || 'N/A'}`);

  // Instantly acknowledge Notehub with 200 OK
  res.status(200).send({ status: 'received' });

  const file = event.file || '';
  const eventData = event.body || {};

  if (file === 'alerts.qo') {
    const alertType = eventData.event || 'Security Breach / Movement Detected';
    const location = eventData.location || 'Parked Location';
    
    console.log(`[ALERT DISPATCH] Processing alert from ${file}: ${alertType}`);
    await sendNtfyAlert(`⚠️ Alert: ${alertType}`, `Movement or status trigger reported at ${location}. Tap to open control panel.`);
  } else if (file === '_track.qo') {
    console.log('[TELEMETRY] Location tracking telemetry received (_track.qo).');
    
    if (eventData.event === 'parked' || eventData.status === 'power_on') {
      await sendNtfyAlert('🅿️ Vehicle Parked / Power On', `Status update received from hardware.`);
    }
  } else {
    console.log(`[NOTEHUB] Ignored unhandled notefile: ${file}`);
  }
}

// Support Notehub webhook routes
app.post('/', handleNotehubEvent);
app.post('/notehub-webhook', handleNotehubEvent);

/**
 * Receives 2FA PIN from iPhone iSH HTML Web Page (index.html)
 */
const handle2FASubmission = async (req, res) => {
  // Correct property accessor for '2fa' key
  const pin = req.body?.pin || req.body?.code || req.body?.['2fa'] || 'No PIN Provided';
  const mode = req.body?.mode || 'DISARMED';

  console.log(`[2FA RECEIVED FROM IPHONE] PIN: ${pin} | Requested Mode: ${mode}`);

  // Notify ntfy that the 2FA submission was received and mode updated
  await sendNtfyAlert('🔑 2FA PIN Submitted', `PIN ${pin} verified. Mode requested: ${mode}`);

  res.status(200).json({ 
    status: 'success', 
    message: '2FA PIN successfully processed by Render backend.',
    pinReceived: pin,
    mode: mode
  });
};

app.post('/verify-2fa', handle2FASubmission);
app.post('/send-2fa', handle2FASubmission);

/**
 * Manual Endpoint for Testing
 */
app.post('/trigger-2fa-request', async (req, res) => {
  console.log('[MANUAL TEST] Sending test push notification...');
  await sendNtfyAlert('2FA Authentication Requested', 'Verification required to disarm system.');
  res.status(200).json({ status: '2FA test notification sent' });
});

/**
 * Render Health Check
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});