const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Server Port & Your Specific ntfy Topic
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'hspg18ms_alerts_3486';

/**
 * Sends a push notification to ntfy.sh
 * Directs alerts to your topic: hspg18ms_alerts_3486
 */
async function sendNtfyAlert(title, message, includeButton = true) {
  try {
    // Sanitize topic string in case full URL was passed in ENV
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

    // Post notification directly to ntfy.sh
    const response = await axios.post('https://ntfy.sh', payload, {
      headers: { 
        'Content-Type': 'application/json' 
      }
    });

    console.log(`[NTFY SUCCESS] Sent to topic "${rawTopic}": "${title}" (Status: ${response.status})`);
  } catch (err) {
    console.error('[NTFY ERROR] Primary dispatch failed:', err.response?.data || err.message);

    // Fallback attempt without action buttons if primary request fails
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

  // Acknowledge Notehub immediately with 200 OK
  res.status(200).send({ status: 'received' });

  const file = event.file || '';
  const eventData = event.body || {};

  // Process Notefile Types
  if (file === 'alerts.qo') {
    const alertType = eventData.event || 'Security / Motion Alert';
    const location = eventData.location || 'Parked Location';
    
    console.log(`[ALERT DISPATCH] Processing alert from ${file}: ${alertType}`);
    await sendNtfyAlert(`Alert: ${alertType}`, `Location update / trigger reported at ${location}.`);
  } else if (file === '_track.qo') {
    console.log('[TELEMETRY] Location tracking event received (_track.qo).');
    
    // If park/power state is sent inside _track.qo, trigger notification
    if (eventData.event === 'parked' || eventData.status === 'power_on') {
      await sendNtfyAlert('Vehicle Parked / Power On', `Status update received from device.`);
    }
  } else {
    console.log(`[NOTEHUB] Ignored unhandled file: ${file}`);
  }
}

// Support both root and /notehub-webhook endpoints
app.post('/', handleNotehubEvent);
app.post('/notehub-webhook', handleNotehubEvent);

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