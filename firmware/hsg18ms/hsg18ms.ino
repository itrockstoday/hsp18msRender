#include <Arduino.h>
#include <Notecard.h>
#include <Wire.h>

#define usbSerial Serial

#ifndef PRODUCT_NOTE_UID
#define PRODUCT_NOTE_UID "com.gmail.hspg18ms:hspg18ms"
#endif

Notecard notecard;

enum AppMode {
  MODE_PARKED,
  MODE_OWNER,
  MODE_BORROWER
};

enum SecurityState {
  STATE_IDLE,
  STATE_AWAITING_2FA,
  STATE_TRACKING_BREACH
};

AppMode currentMode = MODE_PARKED;
SecurityState currentState = STATE_IDLE;

double baselineX = 0.0, baselineY = 0.0, baselineZ = 0.0;
bool baselineSet = false;

double borrowerHomeLat = 0.0;
double borrowerHomeLon = 0.0;
bool borrowerHomeSet = false;

bool geofence30WarningSent = false;
bool geofence40BreachSent = false;

unsigned long twoFaStartTime = 0;
const unsigned long TWO_FA_TIMEOUT_MS = 120000; // 2 Minutes

unsigned long lastTrackingTime = 0;
const unsigned long TRACKING_INTERVAL_MS = 120000; // 2 Minutes

double cachedLat = 0.0;
double cachedLon = 0.0;

void checkInboundNotes();
void checkEnvVars();
void pollOrientationAndGeofence();
void sendAlertNote(const char *eventType, const char *baselineStr = NULL, const char *currentStr = NULL, double extraNum = 0.0);
void updateCachedLocation();
void setMotionDetection(bool enable);
double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2);

void setup() {
  usbSerial.begin(115200);
  int timeout = 50;
  while (!usbSerial && timeout--) delay(100);

  usbSerial.println("\n--- Initializing Motorcycle Security System ---");

  Wire.begin();
  notecard.begin();

  // FIX: Set hub mode to periodic with 1-min sync to bypass 10-minute cellular backoffs
  J *req = notecard.newRequest("hub.set");
  JAddStringToObject(req, "product", PRODUCT_NOTE_UID);
  JAddStringToObject(req, "mode", "periodic");
  JAddNumberToObject(req, "outbound", 1);
  JAddBoolToObject(req, "sync", true);
  notecard.sendRequest(req);

  // Disable background GPS polling so location acquisition never blocks movement alerts
  req = notecard.newRequest("card.location.mode");
  JAddStringToObject(req, "mode", "off");
  notecard.sendRequest(req);

  // Sync Environment Variables
  checkEnvVars();

  // Immediate Boot Notification (No GPS delay)
  sendAlertNote("boot_location_captured");

  // Calibrate Accelerometer Baseline
  setMotionDetection(true);
  usbSerial.println("[SYSTEM READY] Parked Mode Active. Accelerometer Monitoring...");
}

void loop() {
  // 1. Process 2FA Disarm notes from Notehub
  checkInboundNotes();

  // 2. Fetch Remote Dashboard Config
  checkEnvVars();

  // 3. Monitor Physical Motion
  pollOrientationAndGeofence();

  // 4. Handle 2FA Window and Breach State Machine
  if (currentState == STATE_AWAITING_2FA) {
    if (millis() - twoFaStartTime >= TWO_FA_TIMEOUT_MS) {
      usbSerial.println("[ALERT] 2FA Expired! Triggering Security Breach...");
      currentState = STATE_TRACKING_BREACH;
      lastTrackingTime = millis();

      // Step 1: Send Security Breach text alert immediately
      sendAlertNote("security_breach");

      // Step 2: Attempt GPS location fix after breach alert dispatch
      updateCachedLocation();
      sendAlertNote("tracking_update");
    }
  } 
  else if (currentState == STATE_TRACKING_BREACH) {
    if (millis() - lastTrackingTime >= TRACKING_INTERVAL_MS) {
      lastTrackingTime = millis();
      usbSerial.println("[TRACKING] Fetching GPS update for stolen vehicle...");
      updateCachedLocation();
      sendAlertNote("tracking_update");
    }
  }

  delay(1000);
}

// Fetch GPS location non-blockingly
void updateCachedLocation() {
  J *reqFix = notecard.newRequest("card.location");
  notecard.sendRequest(reqFix);
  delay(1000);

  J *req = notecard.newRequest("card.location");
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !notecard.responseError(rsp)) {
    double lat = JGetNumber(rsp, "lat");
    double lon = JGetNumber(rsp, "lon");
    if (lat != 0.0 && lon != 0.0) {
      cachedLat = lat;
      cachedLon = lon;
    }
  }
  notecard.deleteResponse(rsp);
}

// Configure Motion Sensitivity
void setMotionDetection(bool enable) {
  J *req = notecard.newRequest("card.motion.mode");
  JAddBoolToObject(req, "start", enable);
  JAddNumberToObject(req, "sensitivity", 2);
  notecard.sendRequest(req);

  delay(300);

  req = notecard.newRequest("card.motion");
  J *rsp = notecard.requestAndResponse(req);
  if (rsp && !notecard.responseError(rsp)) {
    J *orientation = JGetObject(rsp, "orientation");
    if (orientation) {
      baselineX = JGetNumber(orientation, "x");
      baselineY = JGetNumber(orientation, "y");
      baselineZ = JGetNumber(orientation, "z");
      baselineSet = true;
      usbSerial.printf("[ACCEL BASELINE] Stored X:%.2f Y:%.2f Z:%.2f\n", baselineX, baselineY, baselineZ);
    }
  }
  notecard.deleteResponse(rsp);
}

// Poll Physical Motion
void pollOrientationAndGeofence() {
  if (currentMode == MODE_PARKED && currentState == STATE_IDLE) {
    J *req = notecard.newRequest("card.motion");
    J *rsp = notecard.requestAndResponse(req);
    
    if (rsp && !notecard.responseError(rsp)) {
      J *orientation = JGetObject(rsp, "orientation");
      if (orientation && baselineSet) {
        double curX = JGetNumber(orientation, "x");
        double curY = JGetNumber(orientation, "y");
        double curZ = JGetNumber(orientation, "z");

        double delta = abs(curX - baselineX) + abs(curY - baselineY) + abs(curZ - baselineZ);
        if (delta > 0.35) { // Adjusted sensitivity threshold
          char baseStr[32], curStr[32];
          snprintf(baseStr, sizeof(baseStr), "X:%.1f Y:%.1f", baselineX, baselineY);
          snprintf(curStr, sizeof(curStr), "X:%.1f Y:%.1f", curX, curY);

          usbSerial.printf("[ALERT] Motion Triggered! Delta: %.2f\n", delta);

          // Queue and force sync immediate movement alert over cellular
          sendAlertNote("parked_tilt_moved", baseStr, curStr);

          currentState = STATE_AWAITING_2FA;
          twoFaStartTime = millis();
        }
      }
    }
    notecard.deleteResponse(rsp);
  }
  else if (currentMode == MODE_BORROWER && borrowerHomeSet) {
    updateCachedLocation();
    if (cachedLat != 0.0 && cachedLon != 0.0) {
      double dist = calculateDistanceMiles(borrowerHomeLat, borrowerHomeLon, cachedLat, cachedLon);

      if (dist >= 40.0 && !geofence40BreachSent) {
        sendAlertNote("geofence_breach_40mi", NULL, NULL, dist);
        geofence40BreachSent = true;
      } 
      else if (dist >= 30.0 && dist < 40.0 && !geofence30WarningSent) {
        sendAlertNote("geofence_warning_30mi", NULL, NULL, dist);
        geofence30WarningSent = true;
      }
    }
  }
}

// Send event note with immediate sync
void sendAlertNote(const char *eventType, const char *baselineStr, const char *currentStr, double extraNum) {
  J *req = notecard.newRequest("note.add");
  JAddStringToObject(req, "file", "alerts.qo");
  JAddBoolToObject(req, "sync", true);

  J *body = JCreateObject();
  JAddStringToObject(body, "event", eventType);
  JAddNumberToObject(body, "lat", cachedLat);
  JAddNumberToObject(body, "lon", cachedLon);
  
  if (currentMode == MODE_PARKED) JAddStringToObject(body, "mode", "PARKED");
  else if (currentMode == MODE_OWNER) JAddStringToObject(body, "mode", "OWNER");
  else if (currentMode == MODE_BORROWER) JAddStringToObject(body, "mode", "BORROWER");

  if (baselineStr != NULL) JAddStringToObject(body, "baseline", baselineStr);
  if (currentStr != NULL) JAddStringToObject(body, "current", currentStr);
  if (extraNum > 0.0) JAddNumberToObject(body, "distance", extraNum);

  JAddItemToObject(req, "body", body);
  notecard.sendRequest(req);

  usbSerial.printf("[ALERT DISPATCH] Event note '%s' synced to Notehub.\n", eventType);
}

// Check disarm notes
void checkInboundNotes() {
  J *req = notecard.newRequest("note.get");
  JAddStringToObject(req, "file", "inbound.qi");
  JAddBoolToObject(req, "delete", true);
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !notecard.responseError(rsp)) {
    J *body = JGetObject(rsp, "body");
    if (body) {
      bool verified = JGetBool(body, "verified");
      const char *newMode = JGetString(body, "mode");

      if (verified) {
        usbSerial.println("[DISARM ACCEPTED] 2FA verified!");
        currentState = STATE_IDLE;
        geofence30WarningSent = false;
        geofence40BreachSent = false;

        if (newMode && strlen(newMode) > 0) {
          if (strcmp(newMode, "PARKED") == 0) currentMode = MODE_PARKED;
          else if (strcmp(newMode, "OWNER") == 0) currentMode = MODE_OWNER;
          else if (strcmp(newMode, "BORROWER") == 0) currentMode = MODE_BORROWER;
        }

        if (currentMode == MODE_PARKED) {
          setMotionDetection(true);
        }
      }
    }
  }
  notecard.deleteResponse(rsp);
}

// Sync environment variables
void checkEnvVars() {
  J *req = notecard.newRequest("env.get");
  J *rsp = notecard.requestAndResponse(req);

  if (rsp && !notecard.responseError(rsp)) {
    J *env = JGetObject(rsp, "text");
    if (env) {
      const char *appModeStr = JGetString(env, "app_mode");
      if (appModeStr && strlen(appModeStr) > 0) {
        if (strcmp(appModeStr, "PARKED") == 0 && currentMode != MODE_PARKED) {
          currentMode = MODE_PARKED;
          currentState = STATE_IDLE;
          setMotionDetection(true);
        } else if (strcmp(appModeStr, "OWNER") == 0) {
          currentMode = MODE_OWNER;
          currentState = STATE_IDLE;
        } else if (strcmp(appModeStr, "BORROWER") == 0) {
          currentMode = MODE_BORROWER;
          currentState = STATE_IDLE;
        }
      }

      const char *homeLatStr = JGetString(env, "borrower_home_lat");
      const char *homeLonStr = JGetString(env, "borrower_home_lon");
      if (homeLatStr && homeLonStr) {
        borrowerHomeLat = atof(homeLatStr);
        borrowerHomeLon = atof(homeLonStr);
        borrowerHomeSet = true;
      }
    }
  }
  notecard.deleteResponse(rsp);
}

double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2) {
  double dLat = (lat2 - lat1) * M_PI / 180.0;
  double dLon = (lon2 - lon1) * M_PI / 180.0;
  double a = pow(sin(dLat / 2.0), 2) +
             cos(lat1 * M_PI / 180.0) * cos(lat2 * M_PI / 180.0) *
             pow(sin(dLon / 2.0), 2);
  double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  return 3958.8 * c;
}