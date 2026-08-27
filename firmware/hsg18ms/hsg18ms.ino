#include <Notecard.h>
#include <Wire.h>
#include <math.h>

#define PRODUCT_UID "com.techbyjr.jose:hspg18ms"
#define PIN_TIMEOUT_MS 120000 // 2-Minute 2FA Window
#define usbSerial Serial

Notecard notecard;

enum OperatingMode {
  MODE_PARKED,   // DEFAULT: Tilt/movement active relative to parked baseline
  MODE_OWNER,    // UNRESTRICTED: All alarms off
  MODE_BORROWER  // GEOFENCED: Geofence active, tilt/movement disabled
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

// Parked Baseline Tilt
char parkedBaselineOrientation[32] = "unknown";
bool baselineCaptured = false;

// Borrower Geofence Home Coordinates
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

  // Cellular setup
  J *req = notecard.newRequest("hub.set");
  JAddStringToObject(req, "product", PRODUCT_UID);
  JAddStringToObject(req, "mode", "continuous");
  JAddBoolToObject(req, "sync", true);
  notecard.sendRequest(req);

  // GPS Setup
  req = notecard.newRequest("card.location.mode");
  JAddStringToObject(req, "mode", "periodic");
  JAddNumberToObject(req, "seconds", 15);
  JAddBoolToObject(req, "active", true);
  JAddNumberToObject(req, "max", 10);
  notecard.sendRequest(req);

  // Motion/Orientation Sensing
  req = notecard.newRequest("card.motion.mode");
  JAddNumberToObject(req, "sensitivity", 1);
  JAddBoolToObject(req, "orientation", true);
  JAddBoolToObject(req, "start", true);
  notecard.sendRequest(req);

  // Fetch initial env state
  syncOperatingModeFromNotehub();

  usbSerial.println("\n[BOOT] System initialized. Defaulting to PARKED Mode...");

  if (currentMode == MODE_PARKED) {
    captureParkedBaselineOrientation();
  }

  double initialLat = 0.0, initialLon = 0.0;
  if (waitForGpsLock(initialLat, initialLon, 45)) {
    if (currentMode == MODE_BORROWER && borrowerOriginLat == 0.0) {
      borrowerOriginLat = initialLat;
      borrowerOriginLon = initialLon;
    }
    sendAlertNote("boot_location_captured");
  }
}

void loop() {
  OperatingMode previousMode = currentMode;
  syncOperatingModeFromNotehub();

  // If newly switched into PARKED mode, reset baseline orientation
  if (currentMode == MODE_PARKED && (previousMode != MODE_PARKED || !baselineCaptured)) {
    captureParkedBaselineOrientation();
  }

  // Check incoming 2FA disarm requests continuously across all states
  checkIncoming2FA();

  // OWNER MODE: Disarm everything
  if (currentMode == MODE_OWNER) {
    currentState = STATE_IDLE;
    delay(4000);
    return;
  }

  // IDLE MONITORING STATE
  if (currentState == STATE_IDLE) {

    // 1. PARKED MODE TILT/MOVEMENT SENSING ONLY
    if (currentMode == MODE_PARKED && baselineCaptured) {
      J *req = notecard.newRequest("card.motion");
      J *rsp = notecard.requestAndResponse(req);

      if (rsp && !NoteResponseError(rsp)) {
        const char *currentOrientation = JGetString(rsp, "status");

        if (currentOrientation && strlen(currentOrientation) > 0) {
          // Detect shift from the initial parked tilt position
          if (strcmp(currentOrientation, parkedBaselineOrientation) != 0) {
            usbSerial.printf("\n[ALERT] Parked Tilt Shifted! Baseline: %s | Current: %s\n", 
                              parkedBaselineOrientation, currentOrientation);

            sendAlertNote("parked_tilt_moved", parkedBaselineOrientation, currentOrientation);
            currentState = STATE_AWAITING_2FA;
            motionDetectedTime = millis();
          }
        }
      }
      notecard.deleteResponse(rsp);
    }

    // 2. BORROWER MODE GEOFENCE EVALUATION (Tilt alarms completely ignored)
    if (currentMode == MODE_BORROWER && borrowerOriginLat != 0.0 && borrowerOriginLon != 0.0) {
      double currentLat = 0.0, currentLon = 0.0;
      if (waitForGpsLock(currentLat, currentLon, 5)) {
        double distMiles = calculateDistanceMiles(borrowerOriginLat, borrowerOriginLon, currentLat, currentLon);

        // 30-Mile Warning
        if (distMiles >= 30.0 && distMiles < 40.0) {
          if (!warning30MileSent) {
            sendAlertNote("geofence_warning_30mi", NULL, NULL, distMiles);
            warning30MileSent = true;
          }
        } else if (distMiles < 30.0) {
          warning30MileSent = false;
        }

        // 40-Mile Breach -> Trigger Security Alert & Live Tracking
        if (distMiles >= 40.0) {
          sendAlertNote("geofence_breach_40mi", NULL, NULL, distMiles);
          currentState = STATE_TRACKING_BREACH;
          lastPeriodicTrackTime = millis();
        }
      }
    }
  }

  // 2-MINUTE 2FA TIMEOUT EVALUATION
  if (currentState == STATE_AWAITING_2FA) {
    if (millis() - motionDetectedTime > PIN_TIMEOUT_MS) {
      usbSerial.println("\n[SECURITY BREACH] 2-Minute Window Expired without 2FA PIN!");
      sendAlertNote("security_breach");

      currentState = STATE_TRACKING_BREACH;
      lastPeriodicTrackTime = millis();
    }
  }

  // CONTINUOUS 2-MINUTE GPS TRACKING & BREACH ALERT
  if (currentState == STATE_TRACKING_BREACH) {
    if (millis() - lastPeriodicTrackTime >= 120000) {
      usbSerial.println("\n[TRACKING UPDATE] Dispatching 2-minute breach GPS location...");
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

  if (rsp && !NoteResponseError(rsp)) {
    const char *orient = JGetString(rsp, "status");
    if (orient && strlen(orient) > 0) {
      strncpy(parkedBaselineOrientation, orient, sizeof(parkedBaselineOrientation) - 1);
    } else {
      strcpy(parkedBaselineOrientation, "upright");
    }
    baselineCaptured = true;
    usbSerial.printf("[PARKED BASELINE] Resting tilt locked: %s\n", parkedBaselineOrientation);
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

bool waitForGpsLock(double &lat, double &lon, int maxWaitSeconds) {
  for (int i = 0; i < maxWaitSeconds; i++) {
    J *req = notecard.newRequest("card.location");
    J *rsp = notecard.requestAndResponse(req);

    if (rsp && !NoteResponseError(rsp)) {
      lat = JGetNumber(rsp, "lat");
      lon = JGetNumber(rsp, "lon");
      if (lat != 0.0 && lon != 0.0) {
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

void checkIncoming2FA() {
  J *req = notecard.newRequest("note.get");
  JAddStringToObject(req, "file", "inbound.qi");
  JAddBoolToObject(req, "delete", true);
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !NoteResponseError(rsp)) {
    J *body = JGetObject(rsp, "body");
    if (body && JGetBool(body, "verified")) {
      usbSerial.println("\n[SECURITY] 2FA PIN disarm received! Resetting system to IDLE.");
      currentState = STATE_IDLE;
      if (currentMode == MODE_PARKED) {
        captureParkedBaselineOrientation();
      }
    }
  }
  notecard.deleteResponse(rsp);
}