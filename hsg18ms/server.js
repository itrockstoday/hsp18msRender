const express = require('express');
const nodemailer = require('nodemailer');
const { otplib } = require('otplib');
const axios = require('axios');

const app = express();
app.use(express.json());

const GOOGLE_USER = process.env.GOOGLE_USER;
const GOOGLE_APP_PASS = process.env.GOOGLE_APP_PASS;
const TARGET_SMS_EMAIL = process.env.TARGET_SMS_EMAIL;
const TOTP_SECRET = process.env.TOTP_SECRET;
const NOTEHUB_TOKEN = process.env.NOTEHUB_TOKEN;
const NOTEHUB_PROJECT = process.env.NOTEHUB_PROJECT || 'com.techbyjr.jose:hsg18ms';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GOOGLE_USER, pass: GOOGLE_APP_PASS }
});

function sendSMS(messageText) {
  return transporter.sendMail({
    from: GOOGLE_USER,
    to: TARGET_SMS_EMAIL,
    subject: '',
    text: messageText
  });
}

// Receive Notehub Webhooks
app.post('/notehub-webhook', async (req, res) => {
  try {
    const { event, location, device } = req.body;

    if (event === 'device_moved') {
      await sendSMS("device moved");
      const host = req.headers.host;
      await sendSMS(`Was the device moved by you? Verify TOTP: https://${host}/verify?pin=YOUR_PIN&device=${device}`);
    } 
    else if (event === 'security_breach') {
      const mapsLink = location ? `https://maps.google.com/?q=${location.lat},${location.lon}` : 'Location unknown';
      await sendSMS(`Security breached. Current Location: ${mapsLink}`);
    } 
    else if (location && !event) {
      const mapsLink = `https://maps.google.com/?q=${location.lat},${location.lon}`;
      await sendSMS(`Periodic GPS Report (hsg18ms): ${mapsLink}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error handling webhook:", err.message);
    res.sendStatus(500);
  }
});

// Verify Google Authenticator 2FA PIN
app.get('/verify', async (req, res) => {
  const { pin, device } = req.query;

  if (!pin || !device) return res.status(400).send("Missing PIN or Device ID.");

  const isValid = otplib.authenticator.check(pin, TOTP_SECRET);

  if (isValid) {
    try {
      await axios.post(
        `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT}/devices/${device}/notes`,
        { file: "inbound.qi", body: { verified: true } },
        { headers: { 'X-SESSION-TOKEN': NOTEHUB_TOKEN } }
      );
      res.send("PIN Verified. Alarm disarmed.");
    } catch (err) {
      res.status(500).send("PIN valid, but failed to notify Notehub.");
    }
  } else {
    res.status(400).send("Invalid PIN.");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server hsg18ms running on port ${PORT}`));