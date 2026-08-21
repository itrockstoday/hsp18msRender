const express = require('express');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GOOGLE_APP_PASS
  }
});

// Endpoint route must match Notehub Route URL path exactly
app.post('/notehub-webhook', async (req, res) => {
  console.log("Incoming Notehub Payload:", JSON.stringify(req.body));

  const payload = req.body.body || req.body;
  const event = payload.event;
  const lat = (payload.lat || 0).toFixed(5); // 5 decimals = 1m coordinate precision
  const lon = (payload.lon || 0).toFixed(5);

  const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
  const wazeUrl = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

  let smsBody = "";
  let smsSubject = "";

  if (event === "boot_location_captured") {
    smsSubject = "GPS LOCK";
    smsBody = `Initial 1M Grid captured:\nLat:${lat}, Lon:${lon}\nNav: ${mapsUrl}`;
  } 
  else if (event === "device_moved") {
    smsSubject = "WARNING";
    smsBody = `Device moved!\nGrid: ${lat}, ${lon}\nReply with 2FA PIN within 30s.\nNav: ${mapsUrl}`;
  } 
  else if (event === "security_breach") {
    smsSubject = "ALERT";
    smsBody = `The device is moving! 2FA Unverified.\nGrid: ${lat}, ${lon}\nGoogle: ${mapsUrl}\nWaze: ${wazeUrl}`;
  } 
  else if (event === "tracking_update") {
    smsSubject = "TRACKING";
    smsBody = `The device is moving!\nUpdated Grid: ${lat}, ${lon}\nNav: ${mapsUrl}`;
  } 
  else if (event === "vehicle_tilt_warning") {
    const orientation = payload.orientation || "Tilted";
    smsSubject = "CRITICAL TILT";
    smsBody = `Vehicle Rollover/Tilt Detected (${orientation})!\nGrid: ${lat}, ${lon}\nNav: ${mapsUrl}`;
  }
  else {
    return res.status(200).json({ status: "ignored" });
  }

  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.TARGET_SMS_EMAIL,
      subject: smsSubject,
      text: smsBody
    });

    console.log(`[SMS DISPATCH] Delivered '${event}' alert to ${process.env.TARGET_SMS_EMAIL}`);
    return res.status(200).json({ status: "success", event: event });
  } catch (err) {
    console.error("SMS Delivery Failed:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Render Webhook running on port ${PORT}`));