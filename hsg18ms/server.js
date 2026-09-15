const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Load Environment Variables
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'my_alerts';

/**
 * Sends a push notification to ntfy.sh
 * Ensures URL string manipulation is handled defensively to prevent HTTP 400 Bad Request errors.
 */
async function sendNtfyAlert(title, message, includeButton = true) {
  try {
    // Sanitize NTFY_TOPIC: Extract topic name if user provided full URL in environment variables
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

    // POST directly to ntfy root endpoint using sanitized JSON body
    const response = await axios.post('https://ntfy.sh', payload, {
      headers: { 
        'Content-Type': 'application/json' 
      }
    });

    console.log(`[NTFY SUCCESS] Notification sent: "${title}" (Status: ${response.status})`);
  } catch (err) {
    console.error('[NTFY ERROR] Primary dispatch failed:', err.response?.data || err.message);

    // Fallback attempt without action buttons if primary request fails
    if (includeButton) {
      console.log('[NTFY RETRY] Retrying without interactive buttons...');
      await sendNtfyAlert(title, message, false);
    }
  }
}

/**
 * Webhook Ingestion Endpoint for Notehub Events
 */
app.post('/', async (req, res) => {
  const event = req.body;
  console.log(`[NOTEHUB EVENT] Inbound Event Received: File=${event.file}, Event=${event.body?.event}`);

  // Instantly respond to Notehub to prevent timeout retries
  res.status(200).send({ status: 'received' });

  // Handle Notehub file triggers
  const file = event.file || '';
  const eventData = event.body || {};

  if (file === 'alerts.qo') {
    const alertType = eventData.event || 'Security Alert';
    const location = eventData.location || 'Unknown Location';
    
    console.log(`[ALERT DISPATCH] Processing alert from ${file}: ${alertType}`);
    await sendNtfyAlert(`Security Trigger: ${alertType}`, `Alert triggered at ${location}. Check control panel.`);
  } else if (file === '_track.qo') {
    console.log('[TELEMETRY] Routine telemetry received (_track.qo). No ntfy alert required.');
  } else {
    console.log(`[NOTEHUB] Ignored unhandled notefile: ${file}`);
  }
});

/**
 * Manual Testing Endpoint for 2FA Request
 */
app.post('/trigger-2fa-request', async (req, res) => {
  console.log('[MANUAL TEST] Triggering 2FA alert test...');
  await sendNtfyAlert('2FA Authentication Requested', 'A verification code is required to approve access.');
  res.status(200).json({ status: '2FA notification dispatched successfully' });
});

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});