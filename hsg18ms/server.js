const express = require('express');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(express.json());

// Initialize SendGrid API Key from Render Environment Variables
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

app.post('/notehub-webhook', async (req, res) => {
  console.log("Incoming Notehub Payload:", JSON.stringify(req.body));

  const payload = req.body.body || req.body;
  const event = payload.event;

  // Silently ignore background system files (e.g., _track.qo, _session.qo)
  if (!event) {
    return res.status(200).json({ status: "ignored_internal_system_note" });
  }

  // Extract coordinates with 5 decimal precision (~1 meter accuracy)
  const lat = (payload.lat || 0).toFixed(5);
  const lon = (payload.lon || 0).toFixed(5);

  const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
  const wazeUrl = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

  let smsBody = "";
  let smsSubject = "";

  // Map incoming MCU event types to SMS alert messages
  if (event === "boot_location_captured") {
    smsSubject = "GPS LOCK";
    smsBody = `Initial 1M Grid captured:\nLat:${lat}, Lon:${lon}\nNav: ${mapsUrl}`;
  } 
  else if (event === "device_moved") {
    smsSubject = "WARNING";
    smsBody = `Device moved!\nGrid: ${lat}, ${lon}\nReply with 2FA PIN within 30s.\nNav: ${mapsUrl}`;
  } 
  else if (event === "vehicle_tilt_warning") {
    const orientation = payload.orientation || "Tilted";
    smsSubject = "CRITICAL TILT";
    smsBody = `Vehicle Rollover/Tilt Detected (${orientation})!\nGrid: ${lat}, ${lon}\nNav: ${mapsUrl}`;
  }
  else if (event === "security_breach") {
    smsSubject = "ALERT";
    smsBody = `The device is moving! 2FA Unverified.\nGrid: ${lat}, ${lon}\nGoogle: ${mapsUrl}\nWaze: ${wazeUrl}`;
  } 
  else if (event === "tracking_update") {
    smsSubject = "TRACKING";
    smsBody = `The device is moving!\nUpdated Grid: ${lat}, ${lon}\nNav: ${mapsUrl}`;
  } 
  else {
    return res.status(200).json({ status: "unhandled_event_type" });
  }

  const msg = {
    to: process.env.TARGET_SMS_EMAIL,        // Your phone carrier address (e.g. 1234567890@vtext.com)
    from: process.env.VERIFIED_SENDER_EMAIL,  // The address verified under SendGrid Single Sender
    subject: smsSubject,
    text: smsBody,
  };

  try {
    await sgMail.send(msg);
    console.log(`[SMS DISPATCH SUCCESS] Delivered '${event}' alert to ${process.env.TARGET_SMS_EMAIL}`);
    return res.status(200).json({ status: "success", event: event });
  } catch (error) {
    console.error("SMS Delivery Failed via SendGrid API:", error.response ? error.response.body : error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Render Webhook Service actively listening on port ${PORT}`));