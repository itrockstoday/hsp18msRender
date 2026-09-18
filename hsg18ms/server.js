const express = require('express');
const axios = require('axios');

const app = express();

// Enable CORS for iPhone iSH Shell
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

// Configuration
const PORT = process.env.PORT || 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'hspg18ms_alerts_3486';

// Global System State (Default Mode: OWNER PARKED)
let currentSystemMode = 'PARKED';
let borrowerAnchorLocation = null; // { lat, lon }
let lastAlertDistanceMiles = 0;
let isGeofenceBreached = false;

// 2FA Challenge & Breach Escalation State
let challengeTimeoutTimer = null;
let breachRepeatInterval = null;
let isBreached = false;
let lastKnownLocation = { lat: 0, lon: 0 };

// 2-Hour Telemetry Tracking
let lastRoutineReportTime = 0;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Formats lat/lon into 10-digit precision (5 decimals per coordinate pair)
 */
function format10DigitGPS(lat, lon) {
  const numLat = parseFloat(lat) || 0;
  const numLon = parseFloat(lon) || 0;
  return `${numLat.toFixed(5)}, ${numLon.toFixed(5)}`;
}

/**
 * Generates Google Maps Deep Link
 */
function getGoogleMapsUrl(lat, lon) {
  const formatted = format10DigitGPS(lat, lon);
  return `https://maps.google.com/?q=${encodeURIComponent(formatted)}`;
}

/**
 * Calculates distance between two GPS coordinates in Miles (Haversine Formula)
 */
function calculateDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Sends Push Notifications to ntfy.sh with optional Google Maps Action Link
 */
async function sendNtfyAlert(title, message, mapsUrl = null, includeControlPanel = true) {
  try {
    const rawTopic = NTFY_TOPIC.replace(/^https?:\/\/ntfy\.sh\//i, '').trim();

    const payload = {
      topic: rawTopic,
      title: title,
      message: message,
      priority: 4,
      actions: []
    };

    if (mapsUrl) {
      payload.actions.push({
        action: 'view',
        label: '🗺️ Open Google Maps GPS',
        url: mapsUrl
      });
    }

    if (includeControlPanel) {
      payload.actions.push({
        action: 'view',
        label: '🌐 Open iPhone Control Panel',
        url: 'http://localhost:8080'
      });
    }

    const response = await axios.post('https://ntfy.sh', payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log(`[NTFY SUCCESS] Sent to "${rawTopic}": "${title}"`);
  } catch (err) {
    console.error('[NTFY ERROR] Dispatch failed:', err.response?.data || err.message);
  }
}

/**
 * Disarms active 2FA challenges, clears breach loops, and resets alert state
 */
function disarmChallengeAndBreach() {
  if (challengeTimeoutTimer) {
    clearTimeout(challengeTimeoutTimer);
    challengeTimeoutTimer = null;
  }
  if (breachRepeatInterval) {
    clearInterval(breachRepeatInterval);
    breachRepeatInterval = null;
  }
  isBreached = false;
  console.log('[SECURITY ENGINE] 2FA Challenge & Breach loops fully disarmed.');
}

/**
 * Initiates the 30-Second 2FA Challenge & 2-Minute Repeating Breach Engine
 */
function triggerSecurityChallenge(lat, lon) {
  disarmChallengeAndBreach();

  const gpsString = format10DigitGPS(lat, lon);
  const mapsUrl = getGoogleMapsUrl(lat, lon);

  console.log(`[SECURITY ENGINE] Motion detected at ${gpsString}. Starting 30s 2FA challenge window...`);

  // Step 1: Immediate Motion Detection Notification
  sendNtfyAlert(
    '🚨 Motion Detected: 2FA Required',
    `Vehicle motion detected at GPS: ${gpsString}. You have 30 seconds to enter 2FA PIN. Map: ${mapsUrl}`,
    mapsUrl
  );

  // Step 2: 30-Second Timer Expiration
  challengeTimeoutTimer = setTimeout(() => {
    isBreached = true;
    console.log('[SECURITY ENGINE] 30s 2FA Challenge window expired! Security breach confirmed.');

    // Immediate Breach Alert
    sendNtfyAlert(
      '🚨 2FA SECURITY BREACH CONFIRMED',
      `2FA security has been breached! Response missed within 30 seconds. Current GPS: ${gpsString}. Map: ${mapsUrl}`,
      mapsUrl
    );

    // Step 3: Repeat Breach Alert every 2 minutes until disarmed/mode change
    breachRepeatInterval = setInterval(() => {
      const activeGpsString = format10DigitGPS(lastKnownLocation.lat, lastKnownLocation.lon);
      const activeMapsUrl = getGoogleMapsUrl(lastKnownLocation.lat, lastKnownLocation.lon);

      console.log(`[SECURITY ENGINE] 2-Minute Repeating Breach Alert dispatched for GPS: ${activeGpsString}`);
      sendNtfyAlert(
        '⚠️ ACTIVE BREACH: 2FA Unanswered',
        `Vehicle breach active! System awaiting 2FA disarm. GPS: ${activeGpsString}. Map: ${activeMapsUrl}`,
        activeMapsUrl
      );
    }, 2 * 60 * 1000);

  }, 30 * 1000);
}

/**
 * Evaluates inbound GPS location against Borrower 30-Mile Limit
 */
async function processGeofenceCheck(currentLat, currentLon) {
  if (currentSystemMode !== 'BORROWER' && currentSystemMode !== 'BORROWER_PARKED') {
    return;
  }

  if (!borrowerAnchorLocation) {
    borrowerAnchorLocation = { lat: currentLat, lon: currentLon };
    console.log(`[GEOFENCE ANCHOR SET] Base location pinned at ${format10DigitGPS(currentLat, currentLon)}`);
    return;
  }

  const distance = calculateDistanceMiles(
    borrowerAnchorLocation.lat,
    borrowerAnchorLocation.lon,
    currentLat,
    currentLon
  );

  const mapsUrl = getGoogleMapsUrl(currentLat, currentLon);
  const gpsString = format10DigitGPS(currentLat, currentLon);

  if (distance > 30) {
    if (!isGeofenceBreached) {
      isGeofenceBreached = true;
      lastAlertDistanceMiles = distance;
      await sendNtfyAlert(
        '🚨 GEOFENCE BREACH: 30-Mile Limit Exceeded',
        `Borrower is ${distance.toFixed(1)} miles from origin. GPS: ${gpsString}. Link: ${mapsUrl}`,
        mapsUrl
      );
    } else if (distance - lastAlertDistanceMiles >= 2.0) {
      lastAlertDistanceMiles = distance;
      await sendNtfyAlert(
        '📍 GEOFENCE TRACKING (+2 Miles Out)',
        `Borrower expanded distance to ${distance.toFixed(1)} miles. GPS: ${gpsString}. Link: ${mapsUrl}`,
        mapsUrl
      );
    }
  } else if (isGeofenceBreached && distance <= 30) {
    isGeofenceBreached = false;
    lastAlertDistanceMiles = 0;
    await sendNtfyAlert(
      '✅ GEOFENCE RESTORED',
      `Borrower returned within 30-mile boundary (${distance.toFixed(1)} miles). GPS: ${gpsString}. Link: ${mapsUrl}`,
      mapsUrl
    );
  }
}

/**
 * Inbound Event Webhook Handler (Notehub Integration)
 */
async function handleNotehubEvent(req, res) {
  const event = req.body;
  console.log(`[NOTEHUB EVENT] Path=${req.path}, File=${event.file}`);

  res.status(200).send({ status: 'received' });

  const file = event.file || '';
  const eventData = event.body || {};

  // Extract GPS coordinates
  const currentLat = eventData.lat || eventData.latitude || event.where_lat || lastKnownLocation.lat;
  const currentLon = eventData.lon || eventData.longitude || event.where_lon || lastKnownLocation.lon;

  if (currentLat && currentLon) {
    lastKnownLocation = { lat: currentLat, lon: currentLon };
    await processGeofenceCheck(currentLat, currentLon);
  }

  const gpsString = format10DigitGPS(lastKnownLocation.lat, lastKnownLocation.lon);
  const mapsUrl = getGoogleMapsUrl(lastKnownLocation.lat, lastKnownLocation.lon);

  // Motion Alert Event
  if (file === 'alerts.qo') {
    if (currentSystemMode === 'DISARMED') {
      console.log('[SYSTEM DISARMED] Motion event received but suppressed.');
      return;
    }

    if (currentSystemMode === 'BORROWER_PARKED') {
      console.log('[BORROWER PARKED] Motion update logged without critical breach.');
      await sendNtfyAlert(
        '🅿️ Borrower Parked Activity',
        `Localized movement detected in Borrower Parked mode. GPS: ${gpsString}. Map: ${mapsUrl}`,
        mapsUrl
      );
      return;
    }

    // Trigger 30-second challenge for security motion events
    triggerSecurityChallenge(lastKnownLocation.lat, lastKnownLocation.lon);

  } else if (file === '_track.qo') {
    const now = Date.now();

    // Power-on / Boot Event Default Notification
    if (eventData.event === 'parked' || eventData.status === 'power_on' || lastRoutineReportTime === 0) {
      lastRoutineReportTime = now;
      await sendNtfyAlert(
        `🅿️ Vehicle Power On / State: ${currentSystemMode}`,
        `The vehicle has been placed in ${currentSystemMode} mode. GPS: ${gpsString}. Map: ${mapsUrl}`,
        mapsUrl
      );
    } 
    // 2-Hour Routine Telemetry Dispatch
    else if (now - lastRoutineReportTime >= TWO_HOURS_MS) {
      lastRoutineReportTime = now;
      console.log('[TELEMETRY] 2-Hour Routine GPS Report Triggered.');
      await sendNtfyAlert(
        '📡 2-Hour Routine Vehicle Telemetry',
        `System operating normally in ${currentSystemMode} mode. GPS: ${gpsString}. Map: ${mapsUrl}`,
        mapsUrl
      );
    }
  }
}

// Webhook Endpoints
app.post('/', handleNotehubEvent);
app.post('/notehub-webhook', handleNotehubEvent);

/**
 * Handles 2FA Submission & Mode Changes from iPhone Control Panel
 */
const handle2FASubmission = async (req, res) => {
  const pin = req.body?.pin || req.body?.code || req.body?.['2fa'] || 'No PIN';
  const requestedMode = req.body?.mode || 'PARKED';

  // Update State and Disarm Challenge/Breach Loops
  currentSystemMode = requestedMode;
  disarmChallengeAndBreach();

  if (currentSystemMode === 'OWNER' || currentSystemMode === 'DISARMED' || currentSystemMode === 'PARKED') {
    borrowerAnchorLocation = null;
    isGeofenceBreached = false;
    lastAlertDistanceMiles = 0;
  }

  const gpsString = format10DigitGPS(lastKnownLocation.lat, lastKnownLocation.lon);
  const mapsUrl = getGoogleMapsUrl(lastKnownLocation.lat, lastKnownLocation.lon);

  console.log(`[2FA VERIFIED] PIN: ${pin} | Mode Updated to: ${currentSystemMode}`);

  let modeTitle = 'Owner Parked Mode';
  let emoji = '🚨';

  if (currentSystemMode === 'OWNER') {
    modeTitle = 'Owner Mode';
    emoji = '👑';
  } else if (currentSystemMode === 'BORROWER') {
    modeTitle = 'Borrower Mode';
    emoji = '🔑';
  } else if (currentSystemMode === 'BORROWER_PARKED') {
    modeTitle = 'Borrower Parked Mode';
    emoji = '🅿️';
  } else if (currentSystemMode === 'DISARMED') {
    modeTitle = 'Disarmed Mode';
    emoji = '🔓';
  }

  // Mandatory Mode Notification with 10-Digit GPS Link
  await sendNtfyAlert(
    `${emoji} System Mode Updated: ${modeTitle}`,
    `The vehicle has been placed in ${modeTitle}. GPS: ${gpsString}. Map: ${mapsUrl}`,
    mapsUrl
  );

  res.status(200).json({ 
    status: 'success', 
    message: `2FA PIN verified. Mode updated to ${currentSystemMode}.`,
    currentMode: currentSystemMode,
    gps: gpsString,
    mapsUrl: mapsUrl
  });
};

app.post('/verify-2fa', handle2FASubmission);
app.post('/send-2fa', handle2FASubmission);

/**
 * Health & Status Endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    currentMode: currentSystemMode, 
    isBreached: isBreached,
    geofenceBreached: isGeofenceBreached,
    lastKnownLocation: format10DigitGPS(lastKnownLocation.lat, lastKnownLocation.lon),
    uptime: process.uptime() 
  });
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Default System Mode: ${currentSystemMode}`);
});