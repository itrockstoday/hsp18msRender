const express = require('express');
const axios = require('axios');

const app = express();

// Enable CORS so your Python web page can make fetch/XHR requests to Render
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

// Server Port & Your Specific ntfy Topic
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'hspg18ms_alerts_3486';

/**
 * Sends a push notification to ntfy.sh
 * Directs alerts to your topic: hspg18ms_alerts_3486
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
          label: '🌐 Open Control Panel',
          url: 'http://localhost:8080'
        }
      ];
    }

    const response = await axios.post('https://ntfy.sh', payload, {
      headers: { 
        'Content-Type': 'application/json' 
      }
    });

    console.log(`[NTFY SUCCESS] Sent to topic "${rawTopic}": "${title}" (Status: ${response.status})`);
  } catch (err) {
    console.error('[NTFY ERROR] Primary dispatch failed:', err.response?.data || err.message);

    if (includeButton) {
      console.log('[NTFY RETRY] Retrying dispatch without action buttons...');
      await sendNtfyAlert(title, message, false);
    }
  }
}

/**
 * Shared Inbound Notehub Event Handler
 * Supports both / and /notehub-webhook paths
 */
async function handleNotehubEvent(req, res) {
  const event = req.body;
  console.log(`[NOTEHUB EVENT] Inbound Event: Path=${req.path}, File=${event.file}, Event=${event.body?.event || 'N/A'}`);

  res.status(200).send({ status: 'received' });

  const file = event.file || '';
  const eventData = event.body || {};

  if (file === 'alerts.qo') {
    const alertType = eventData.event || 'Security / Motion Alert';
    const location = eventData.location || 'Parked Location';
    
    console.log(`[ALERT DISPATCH] Processing alert from ${file}: ${alertType}`);
    await sendNtfyAlert(`Alert: ${alertType}`, `Location update / trigger reported at ${location}.`);
  } else if (file === '_track.qo') {
    console.log('[TELEMETRY] Location tracking event received (_track.qo).');
    
    if (eventData.event === 'parked' || eventData.status === 'power_on') {
      await sendNtfyAlert('Vehicle Parked / Power On', `Status update received from device.`);
    }
  } else {
    console.log(`[NOTEHUB] Ignored unhandled file: ${file}`);
  }
}

// Notehub Webhook Routes
app.post('/', handleNotehubEvent);
app.post('/notehub-webhook', handleNotehubEvent);

/**
 * Endpoint to Receive 2FA Code/Pin from your Python Web Page
 */
const handle2FASubmission = async (req, res) => {
  // Corrected bracket syntax for property keys starting with numbers
  const pin = req.body?.pin || req.body?.code || req.body?.['2fa'] || 'No PIN Provided';
  console.log(`[2FA SUBMISSION] Received 2FA Code from Python Web Page: ${pin}`);

  await sendNtfyAlert('🔑 2FA Verification Code', `Code Received: ${pin}`);

  res.status(200).json({ status: 'success', message: '2FA PIN received and sent via ntfy' });
};

app.post('/verify-2fa', handle2FASubmission);
app.post('/send-2fa', handle2FASubmission);

/**
 * Manual Testing Endpoint
 */
app.post('/trigger-2fa-request', async (req, res) => {
  console.log('[MANUAL TEST] Dispatching test notification...');
  await sendNtfyAlert('2FA Authentication Requested', 'Verification required to approve access.');
  res.status(200).json({ status: '2FA notification sent successfully' });
});

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// Start Express Web Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});