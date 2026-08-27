#include <Notecard.h>
#include <Wire.h>
#include <math.h>

#define PRODUCT_UID "com.techbyjr.jose:hspg18ms"
#define PIN_TIMEOUT_MS 120000 // 2-Minute 2FA Window
#define usbSerial Serial

Notecard notecard;

enum OperatingMode {
  MODE_PARKED,   // DEFAULT: Parked baseline tilt sensing active
  MODE_OWNER,    // UNRESTRICTED: All movement/tilt alarms disabled
  MODE_BORROWER  // GEOFENCED: 30-mi warning & 40-mi breach tracking active, tilt alarms disabled
};

enum DeviceState {
  STATE_IDLE,
  STATE_AWAITING_2FA,
  STATE_TRACKING_BREACH
};

OperatingMode currentMode = MODE_PARKED;
DeviceState currentState = STATE_IDLE;

unsigned long motionDetectedTime = 0;
unsigned long lastPeriodicTrackTime = 0;

// Parked Baseline Tilt Tracking
char parkedBaselineOrientation[32] = "unknown";
bool baselineCaptured = false;

// Borrower Geofence High-Precision Coordinates (64-bit doubles)
double borrowerOriginLat = 0.0;
double borrowerOriginLon = 0.0;
bool warning30MileSent = false;

// Function Declarations
void sendAlertNote(const char *eventType, const char *baselineStr = NULL, const char *currentStr = NULL, double extraNum = 0.0);
void checkIncoming2FA();
void syncOperatingModeFromNotehub();
bool waitForGpsLock(double &lat, double &lon, int maxWaitSeconds);
double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2);
void captureParkedBaselineOrientation();

void setup() {
  delay(2500);
  usbSerial.begin(115200);

  Wire.begin();
  notecard.begin();
  notecard.setDebugOutputStream(usbSerial);

  // 1. Cellular Network Configuration
  J *req = notecard.newRequest("hub.set");
  JAddStringToObject(req, "product", PRODUCT_UID);
  JAddStringToObject(req, "mode", "continuous");
  JAddBoolToObject(req, "sync", true);
  notecard.sendRequest(req);

  // 2. Clear stale cache to force fresh GNSS lock
  req = notecard.newRequest("card.location.dispatch");
  JAddBoolToObject(req, "reset", true);
  notecard.sendRequest(req);

  // 3. High-Precision GNSS / Active Antenna Configuration
  req = notecard.newRequest("card.location.mode");
  JAddStringToObject(req, "mode", "continuous"); // Continuous engine mode forces active satellite scanning
  JAddBoolToObject(req, "vbias", true);          // Powers 3.3V active antenna LNA
  JAddBoolToObject(req, "active", true);         // Active antenna circuit enabled
  JAddBoolToObject(req, "high", true);           // Force high-accuracy 1-meter multi-constellation fix
  JAddNumberToObject(req, "max", 180);           // Allow up to 180s search window for fresh fix
  notecard.sendRequest(req);

  // 4. Motion & Orientation Sensing Setup
  req = notecard.newRequest("card.motion.mode");
  JAddNumberToObject(req, "sensitivity", 1);
  JAddBoolToObject(req, "orientation", true);
  JAddBoolToObject(req, "start", true);
  notecard.sendRequest(req);

  syncOperatingModeFromNotehub();

  usbSerial.println("\n[BOOT] System Power On. Defaulting to PARKED Mode...");

  if (currentMode == MODE_PARKED) {
    captureParkedBaselineOrientation();
  }

  // Attempt high-precision GNSS satellite lock on boot
  double initialLat = 0.0, initialLon = 0.0;
  if (waitForGpsLock(initialLat, initialLon, 60)) {
    if (currentMode == MODE_BORROWER && borrowerOriginLat == 0.0) {
      borrowerOriginLat = initialLat;
      borrowerOriginLon = initialLon;
      usbSerial.printf("[BORROWER] Dynamic Home Pin captured: %.7f, %.7f\n", borrowerOriginLat, borrowerOriginLon);
    }
    sendAlertNote("boot_location_captured");
  }
}

void loop() {
  OperatingMode previousMode = currentMode;
  syncOperatingModeFromNotehub();

  // Reset parked baseline orientation if mode changed to PARKED or baseline missing
  if (currentMode == MODE_PARKED && (previousMode != MODE_PARKED || !baselineCaptured)) {
    captureParkedBaselineOrientation();
  }

  checkIncoming2FA();

  // OWNER MODE: Fully disarmed
  if (currentMode == MODE_OWNER) {
    currentState = STATE_IDLE;
    delay(4000);
    return;
  }

  // IDLE MONITORING STATE
  if (currentState == STATE_IDLE) {

    // 1. PARKED MODE TILT SENSING (ISOLATED TO PARKED MODE ONLY)
    if (currentMode == MODE_PARKED && baselineCaptured) {
      J *req = notecard.newRequest("card.motion");
      J *rsp = notecard.requestAndResponse(req);

      if (rsp && !NoteResponseError(rsp)) {
        const char *currentOrientation = JGetString(rsp, "status");

        if (currentOrientation && strlen(currentOrientation) > 0) {
          if (strcmp(currentOrientation, parkedBaselineOrientation) != 0) {
            usbSerial.printf("\n[ALERT] Parked Position Shifted! Baseline: %s | Current: %s\n", 
                               parkedBaselineOrientation, currentOrientation);

            sendAlertNote("parked_tilt_moved", parkedBaselineOrientation, currentOrientation);
            currentState = STATE_AWAITING_2FA;
            motionDetectedTime = millis();
          }
        }
      }
      notecard.deleteResponse(rsp);
    }

    // 2. BORROWER MODE GEOFENCE EVALUATION (Tilt/Motion alarms disabled)
    if (currentMode == MODE_BORROWER && borrowerOriginLat != 0.0 && borrowerOriginLon != 0.0) {
      double currentLat = 0.0, currentLon = 0.0;
      if (waitForGpsLock(currentLat, currentLon, 10)) {
        double distMiles = calculateDistanceMiles(borrowerOriginLat, borrowerOriginLon, currentLat, currentLon);

        // 30-Mile Warning Threshold
        if (distMiles >= 30.0 && distMiles < 40.0) {
          if (!warning30MileSent) {
            usbSerial.printf("\n[30-MILE WARNING] Vehicle is %.2f miles from Home Location.\n", distMiles);
            sendAlertNote("geofence_warning_30mi", NULL, NULL, distMiles);
            warning30MileSent = true;
          }
        } else if (distMiles < 30.0) {
          warning30MileSent = false;
        }

        // 40-Mile Breach Threshold
        if (distMiles >= 40.0) {
          usbSerial.printf("\n[40-MILE BREACH] Vehicle is %.2f miles from Home Location! Notifying Owner.\n", distMiles);
          sendAlertNote("geofence_breach_40mi", NULL, NULL, distMiles);
          currentState = STATE_TRACKING_BREACH;
          lastPeriodicTrackTime = millis();
        }
      }
    }
  }

  // 2-MINUTE TIMEOUT EVALUATION
  if (currentState == STATE_AWAITING_2FA) {
    if (millis() - motionDetectedTime > PIN_TIMEOUT_MS) {
      usbSerial.println("\n[SECURITY BREACH] 2-Minute Window Expired without 2FA PIN!");
      sendAlertNote("security_breach");

      currentState = STATE_TRACKING_BREACH;
      lastPeriodicTrackTime = millis();
    }
  }

  // CONTINUOUS 2-MINUTE GPS TRACKING & BREACH ALERTS
  if (currentState == STATE_TRACKING_BREACH) {
    if (millis() - lastPeriodicTrackTime >= 120000) {
      usbSerial.println("\n[TRACKING UPDATE] Dispatching 2-minute breach GPS location...");
      sendAlertNote("tracking_update");
      lastPeriodicTrackTime = millis();
    }
  }

  delay(2000);
}

// Storing resting tilt baseline position when entering PARKED mode
void captureParkedBaselineOrientation() {
  delay(1000);
  J *req = notecard.newRequest("card.motion");
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !NoteResponseError(rsp)) {
    const char *orient = JGetString(rsp, "status");
    if (orient && strlen(orient) > 0) {
      strncpy(parkedBaselineOrientation, orient, sizeof(parkedBaselineOrientation) - 1);
    } else {
      strcpy(parkedBaselineOrientation, "upright");
    }
    baselineCaptured = true;
    usbSerial.printf("[PARKED BASELINE] Resting orientation stored: %s\n", parkedBaselineOrientation);
  }
  notecard.deleteResponse(rsp);
}

// 64-bit double precision Haversine calculation
double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2) {
  double lat1Rad = lat1 * M_PI / 180.0;
  double lon1Rad = lon1 * M_PI / 180.0;
  double lat2Rad = lat2 * M_PI / 180.0;
  double lon2Rad = lon2 * M_PI / 180.0;

  double dLat = lat2Rad - lat1Rad;
  double dLon = lon2Rad - lon1Rad;

  double a = sin(dLat / 2.0) * sin(dLat / 2.0) +
             cos(lat1Rad) * cos(lat2Rad) *
             sin(dLon / 2.0) * sin(dLon / 2.0);

  double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  return 3958.8 * c;
}

// Synchronizes configuration variables from Notehub environment
void syncOperatingModeFromNotehub() {
  J *req = notecard.newRequest("env.get");
  JAddStringToObject(req, "name", "app_mode");
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !NoteResponseError(rsp)) {
    const char *modeStr = JGetString(rsp, "text");
    if (modeStr) {
      if (strcmp(modeStr, "OWNER") == 0) currentMode = MODE_OWNER;
      else if (strcmp(modeStr, "BORROWER") == 0) currentMode = MODE_BORROWER;
      else currentMode = MODE_PARKED;
    }
  }
  notecard.deleteResponse(rsp);

  req = notecard.newRequest("env.get");
  JAddStringToObject(req, "name", "borrower_home_lat");
  rsp = notecard.requestAndResponse(req);
  if (rsp && !NoteResponseError(rsp)) {
    const char *latStr = JGetString(rsp, "text");
    if (latStr && strlen(latStr) > 0) borrowerOriginLat = atof(latStr);
  }
  notecard.deleteResponse(rsp);

  req = notecard.newRequest("env.get");
  JAddStringToObject(req, "name", "borrower_home_lon");
  rsp = notecard.requestAndResponse(req);
  if (rsp && !NoteResponseError(rsp)) {
    const char *lonStr = JGetString(rsp, "text");
    if (lonStr && strlen(lonStr) > 0) borrowerOriginLon = atof(lonStr);
  }
  notecard.deleteResponse(rsp);
}

// High-precision coordinate extraction with satellite tracking
bool waitForGpsLock(double &lat, double &lon, int maxWaitSeconds) {
  for (int i = 0; i < maxWaitSeconds; i++) {
    J *req = notecard.newRequest("card.location");
    J *rsp = notecard.requestAndResponse(req);

    if (rsp && !NoteResponseError(rsp)) {
      int sats = JGetInt(rsp, "sats");
      int accuracy = JGetInt(rsp, "accuracy");

      lat = JGetNumber(rsp, "lat");
      lon = JGetNumber(rsp, "lon");

      usbSerial.printf("[GNSS POLLING] Satellites: %d | Lat: %.7f, Lon: %.7f\n", sats, lat, lon);

      // Verify active satellite lock with valid coordinates
      if (lat != 0.0 && lon != 0.0 && sats >= 4) {
        usbSerial.printf("\n[HIGH-PRECISION LOCK] Lat: %.7f, Lon: %.7f (%d SVs, Accuracy: ~%dm)\n", 
                         lat, lon, sats, accuracy);
        notecard.deleteResponse(rsp);
        return true;
      }
    }
    notecard.deleteResponse(rsp);
    delay(1000);
  }
  return false;
}

// Dispatches notes to Notehub outbound queue
void sendAlertNote(const char *eventType, const char *baselineStr, const char *currentStr, double extraNum) {
  J *req = notecard.newRequest("card.location");
  J *rsp = notecard.requestAndResponse(req);

  double lat = 0.0, lon = 0.0;
  if (rsp && !NoteResponseError(rsp)) {
    lat = JGetNumber(rsp, "lat");
    lon = JGetNumber(rsp, "lon");
  }
  notecard.deleteResponse(rsp);

  req = notecard.newRequest("note.add");
  JAddStringToObject(req, "file", "alerts.qo");
  JAddBoolToObject(req, "sync", true);

  J *body = JCreateObject();
  JAddStringToObject(body, "event", eventType);
  JAddNumberToObject(body, "lat", lat);
  JAddNumberToObject(body, "lon", lon);
  
  if (currentMode == MODE_PARKED) JAddStringToObject(body, "mode", "PARKED");
  else if (currentMode == MODE_OWNER) JAddStringToObject(body, "mode", "OWNER");
  else if (currentMode == MODE_BORROWER) JAddStringToObject(body, "mode", "BORROWER");

  if (baselineStr != NULL) JAddStringToObject(body, "baseline", baselineStr);
  if (currentStr != NULL) JAddStringToObject(body, "current", currentStr);
  if (extraNum > 0.0) JAddNumberToObject(body, "distance", extraNum);

  JAddItemToObject(req, "body", body);
  notecard.sendRequest(req);
}

// Checks incoming disarm notes from Notehub
void checkIncoming2FA() {
  J *req = notecard.newRequest("note.get");
  JAddStringToObject(req, "file", "inbound.qi");
  JAddBoolToObject(req, "delete", true);
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !NoteResponseError(rsp)) {
    J *body = JGetObject(rsp, "body");
    if (body && JGetBool(body, "verified")) {
      usbSerial.println("\n[SECURITY] 2FA disarm verified over cellular. System disarmed.");
      currentState = STATE_IDLE;
      if (currentMode == MODE_PARKED) {
        captureParkedBaselineOrientation();
      }
    }
  }
  notecard.deleteResponse(rsp);
}