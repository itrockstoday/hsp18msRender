#include <Notecard.h>
#include <Wire.h>
#include <math.h>

#define PRODUCT_UID "com.techbyjr.jose:hspg18ms"
#define PIN_TIMEOUT_MS 120000 // 2-Minute 2FA Window
#define usbSerial Serial

Notecard notecard;

enum OperatingMode {
  MODE_PARKED,   // DEFAULT: Parked baseline tilt/orientation sensing active
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

// Borrower Geofence Coordinates
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

  // 1. Cellular Network Setup
  J *req = notecard.newRequest("hub.set");
  JAddStringToObject(req, "product", PRODUCT_UID);
  JAddStringToObject(req, "mode", "continuous");
  JAddBoolToObject(req, "sync", true);
  notecard.sendRequest(req);

  // 2. Clear stale cache
  req = notecard.newRequest("card.location.dispatch");
  JAddBoolToObject(req, "reset", true);
  notecard.sendRequest(req);

  // 3. GNSS & Active Antenna Power Configuration
  req = notecard.newRequest("card.location.mode");
  JAddStringToObject(req, "mode", "continuous");
  JAddBoolToObject(req, "vbias", true);   // 3.3V bias for Bingfu LNA Active Antenna
  JAddBoolToObject(req, "active", true);  // Enable active antenna circuit
  JAddBoolToObject(req, "high", true);
  JAddNumberToObject(req, "max", 180);
  notecard.sendRequest(req);

  // 4. Motion Sensing Setup
  req = notecard.newRequest("card.motion.mode");
  JAddNumberToObject(req, "sensitivity", 1);
  JAddBoolToObject(req, "orientation", true);
  JAddBoolToObject(req, "start", true);
  notecard.sendRequest(req);

  syncOperatingModeFromNotehub();
  captureParkedBaselineOrientation();

  usbSerial.println("\n[BOOT] System Power On. Mode: PARKED.");

  // Fast 15-second attempt for satellite coordinates on boot
  double bootLat = 0.0, bootLon = 0.0;
  waitForGpsLock(bootLat, bootLon, 15);

  if (currentMode == MODE_BORROWER && borrowerOriginLat == 0.0 && bootLat != 0.0) {
    borrowerOriginLat = bootLat;
    borrowerOriginLon = bootLon;
  }

  // Dispatch startup notification with coordinates (NO 2FA REQUIRED)
  sendAlertNote("boot_location_captured");
}

void loop() {
  OperatingMode previousMode = currentMode;
  
  syncOperatingModeFromNotehub();
  checkIncoming2FA();

  if (currentMode == MODE_PARKED && (previousMode != MODE_PARKED || !baselineCaptured)) {
    captureParkedBaselineOrientation();
  }

  // OWNER MODE: Disarmed
  if (currentMode == MODE_OWNER) {
    currentState = STATE_IDLE;
    delay(4000);
    return;
  }

  // IDLE MONITORING STATE
  if (currentState == STATE_IDLE) {

    // 1. PARKED MODE TILT SENSING
    if (currentMode == MODE_PARKED && baselineCaptured) {
      J *req = notecard.newRequest("card.motion");
      J *rsp = notecard.requestAndResponse(req);

      if (rsp && !notecard.responseError(rsp)) {
        const char *currentOrientation = JGetString(rsp, "status");

        if (currentOrientation && strlen(currentOrientation) > 0) {
          if (strcmp(currentOrientation, parkedBaselineOrientation) != 0) {
            usbSerial.printf("\n[ALERT] Tilt Changed! Baseline: %s | Current: %s\n", 
                           parkedBaselineOrientation, currentOrientation);

            sendAlertNote("parked_tilt_moved", parkedBaselineOrientation, currentOrientation);
            currentState = STATE_AWAITING_2FA;
            motionDetectedTime = millis();
          }
        }
      }
      notecard.deleteResponse(rsp);
    }

    // 2. BORROWER MODE GEOFENCE EVALUATION
    if (currentMode == MODE_BORROWER && borrowerOriginLat != 0.0 && borrowerOriginLon != 0.0) {
      double currentLat = 0.0, currentLon = 0.0;
      if (waitForGpsLock(currentLat, currentLon, 10)) {
        double distMiles = calculateDistanceMiles(borrowerOriginLat, borrowerOriginLon, currentLat, currentLon);

        if (distMiles >= 30.0 && distMiles < 40.0) {
          if (!warning30MileSent) {
            sendAlertNote("geofence_warning_30mi", NULL, NULL, distMiles);
            warning30MileSent = true;
          }
        } else if (distMiles < 30.0) {
          warning30MileSent = false;
        }

        if (distMiles >= 40.0) {
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

  // 2-MINUTE GPS TRACKING UPDATES
  if (currentState == STATE_TRACKING_BREACH) {
    if (millis() - lastPeriodicTrackTime >= 120000) {
      sendAlertNote("tracking_update");
      lastPeriodicTrackTime = millis();
    }
  }

  delay(2000);
}

void captureParkedBaselineOrientation() {
  delay(1000);
  J *req = notecard.newRequest("card.motion");
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !notecard.responseError(rsp)) {
    const char *orient = JGetString(rsp, "status");
    if (orient && strlen(orient) > 0) {
      strncpy(parkedBaselineOrientation, orient, sizeof(parkedBaselineOrientation) - 1);
    } else {
      strcpy(parkedBaselineOrientation, "upright");
    }
    baselineCaptured = true;
    usbSerial.printf("[PARKED BASELINE] Stored: %s\n", parkedBaselineOrientation);
  }
  notecard.deleteResponse(rsp);
}

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

void syncOperatingModeFromNotehub() {
  J *req = notecard.newRequest("env.get");
  JAddStringToObject(req, "name", "app_mode");
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !notecard.responseError(rsp)) {
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
  if (rsp && !notecard.responseError(rsp)) {
    const char *latStr = JGetString(rsp, "text");
    if (latStr && strlen(latStr) > 0) borrowerOriginLat = atof(latStr);
  }
  notecard.deleteResponse(rsp);

  req = notecard.newRequest("env.get");
  JAddStringToObject(req, "name", "borrower_home_lon");
  rsp = notecard.requestAndResponse(req);
  if (rsp && !notecard.responseError(rsp)) {
    const char *lonStr = JGetString(rsp, "text");
    if (lonStr && strlen(lonStr) > 0) borrowerOriginLon = atof(lonStr);
  }
  notecard.deleteResponse(rsp);
}

bool waitForGpsLock(double &lat, double &lon, int maxWaitSeconds) {
  for (int i = 0; i < maxWaitSeconds; i++) {
    J *req = notecard.newRequest("card.location");
    J *rsp = notecard.requestAndResponse(req);

    if (rsp && !notecard.responseError(rsp)) {
      int sats = JGetInt(rsp, "sats");
      lat = JGetNumber(rsp, "lat");
      lon = JGetNumber(rsp, "lon");

      if (lat != 0.0 && lon != 0.0 && sats >= 1) {
        usbSerial.printf("[GNSS LOCK] Lat: %.8f, Lon: %.8f (%d SVs)\n", lat, lon, sats);
        notecard.deleteResponse(rsp);
        return true;
      }
    }
    notecard.deleteResponse(rsp);
    delay(1000);
  }
  return false;
}

void sendAlertNote(const char *eventType, const char *baselineStr, const char *currentStr, double extraNum) {
  J *req = notecard.newRequest("card.location");
  J *rsp = notecard.requestAndResponse(req);

  double lat = 0.0, lon = 0.0;
  if (rsp && !notecard.responseError(rsp)) {
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

void checkIncoming2FA() {
  J *req = notecard.newRequest("note.get");
  JAddStringToObject(req, "file", "inbound.qi");
  JAddBoolToObject(req, "delete", true);
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !notecard.responseError(rsp)) {
    J *body = JGetObject(rsp, "body");
    if (body && JGetBool(body, "verified")) {
      usbSerial.println("\n[SECURITY] Disarm verified over cellular. Resetting to IDLE.");
      currentState = STATE_IDLE;
      if (currentMode == MODE_PARKED) {
        captureParkedBaselineOrientation();
      }
    }
  }
  notecard.deleteResponse(rsp);
}