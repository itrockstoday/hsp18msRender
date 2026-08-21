const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.post('/notehub-webhook', async (req, res) => {
  console.log("Incoming Notehub Payload:", JSON.stringify(req.body));

  const payload = req.body.body || req.body;
  const event = payload.event;

  // Ignore background system files (_track.qo, _session.qo)
  if (!event) {
    return res.status(200).json({ status: "ignored_internal_system_note" });
  }

  // Format coordinates (~1 meter accuracy)
  const lat = (payload.lat || 0).toFixed(5);
  const lon = (payload.lon || 0).toFixed(5);
  const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
  const wazeUrl = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

  let alertTitle = "";
  let alertMessage = "";
  let priority = "3"; // 1=min, 3=default, 5=max (urgent sound/vibration)
  let tags = [];

  if (event === "boot_location_captured") {
    alertTitle = "📍 GPS LOCK ACQUIRED";
    alertMessage = `Initial 1M Grid captured:\nLat: ${lat}, Lon: ${lon}`;
    priority = "3";
    tags = ["satellite", "round_pushpin"];
  } 
  else if (event === "device_moved") {
    alertTitle = "⚠️ DEVICE MOVED";
    alertMessage = `Movement detected!\nGrid: ${lat}, ${lon}\nAcknowledgment required within 30s.`;
    priority = "4"; // High priority (bypasses silent mode on Android)
    tags = ["warning", "rotating_light"];
  } 
  else if (event === "vehicle_tilt_warning") {
    const orientation = payload.orientation || "Tilted";
    alertTitle = "🚨 CRITICAL TILT DETECTED";
    alertMessage = `Vehicle Rollover/Tilt (${orientation})!\nGrid: ${lat}, ${lon}`;
    priority = "5"; // Urgent priority
    tags = ["alert", "car"];
  }
  else if (event === "security_breach") {
    alertTitle = "⛔ SECURITY BREACH";
    alertMessage = `2FA Unverified! Device moving.\nGrid: ${lat}, ${lon}`;
    priority = "5";
    tags = ["no_entry_sign", "siren"];
  } 
  else if (event === "tracking_update") {
    alertTitle = "📡 TRACKING UPDATE";
    alertMessage = `Updated Grid: ${lat}, ${lon}`;
    priority = "3";
    tags = ["compass"];
  } 
  else {
    return res.status(200).json({ status: "unhandled_event_type" });
  }

  try {
    const topic = process.env.NTFY_TOPIC_NAME;

    if (!topic) {
      console.error("NTFY_TOPIC_NAME is missing in Render Environment Variables.");
      return res.status(500).json({ status: "error", message: "Missing NTFY_TOPIC_NAME" });
    }

    // Send Push Notification directly to phone
    await axios.post(`https://ntfy.sh/${topic}`, alertMessage, {
      headers: {
        'Title': alertTitle,
        'Priority': priority,
        'Tags': tags.join(','),
        'Click': mapsUrl, // Tapping the notification opens Google Maps directly
        'Actions': `view, Open Waze, ${wazeUrl}` // Action button inside notification
      }
    });

    console.log(`[PUSH DISPATCH SUCCESS] Sent '${event}' to topic '${topic}'`);
    return res.status(200).json({ status: "success", event: event });

  } catch (error) {
    console.error("Push Dispatch Failed via ntfy:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Render Webhook Service actively listening on port ${PORT}`));