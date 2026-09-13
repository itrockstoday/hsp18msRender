#include <Arduino.h>
#include <Notecard.h>
#include <Wire.h>

// Debug output stream
#define usbSerial Serial

// Product UID for Notehub
#ifndef PRODUCT_NOTE_UID
#define PRODUCT_NOTE_UID "com.gmail.hspg18ms:hspg18ms"
#endif

Notecard notecard;

// Operating Modes
enum AppMode {
  MODE_PARKED,
  MODE_OWNER,
  MODE_BORROWER
};

// Security State Machine
enum SecurityState {
  STATE_IDLE,
  STATE_AWAITING_2FA,
  STATE_TRACKING_BREACH
};

AppMode currentMode = MODE_PARKED;
SecurityState currentState = STATE_IDLE;

// Baseline Tilt Orientation (Accelerometer)
double baselineX = 0.0, baselineY = 0.0, baselineZ = 0.0;
bool baselineSet = false;

// Borrower Home Location
double borrowerHomeLat = 0.0;
double borrowerHomeLon = 0.0;
bool borrowerHomeSet = false;

// Geofence Warning Flags
bool geofence30WarningSent = false;
bool geofence40BreachSent = false;

// Timer tracking (ms)
unsigned long twoFaStartTime = 0;
const unsigned long TWO_FA_TIMEOUT_MS = 120000; // 2 Minutes

unsigned long lastTrackingTime = 0;
const unsigned long TRACKING_INTERVAL_MS = 120000; // 2 Minutes GPS Tracking Interval

// Global Cached Location
double cachedLat = 0.0;
double cachedLon = 0.0;

// Function Prototypes
void checkInboundNotes();
void checkEnvVars();
void pollOrientationAndGeofence();
void sendAlertNote(const char *eventType, const char *baselineStr = NULL, const char *currentStr = NULL, double extraNum = 0.0);
void updateCachedLocation(bool waitForLock = false);
void setMotionDetection(bool enable);
double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2);

void setup() {
  usbSerial.begin(115200);
  int timeout = 50;
  while (!usbSerial && timeout--) delay(100);

  usbSerial.println("\n--- Initializing Motorcycle Security System ---");

  Wire.begin();
  notecard.begin();

  // Configure Cellular Notecard for Continuous Sync Mode
  J *req = notecard.newRequest("hub.set");
  JAddStringToObject(req, "product", PRODUCT_NOTE_UID);
  JAddStringToObject(req, "mode", "continuous");
  JAddBoolToObject(req, "sync", true); // FIX: Used JAddBoolToObject instead of JAddStringToObject
  notecard.sendRequest(req);

  // Configure Location Services: Set to off/manual mode so background 2-minute updates do NOT fire automatically
  req = notecard.newRequest("card.location.mode");
  JAddStringToObject(req, "mode", "off");
  notecard.sendRequest(req);

  // Initial Location Fetch (Non-blocking cached pull)
  updateCachedLocation(false);

  // Initial Sync of Environment Variables
  checkEnvVars();

  // Boot Alert Dispatch
  sendAlertNote("boot_location_captured");

  // Configure Accelerometer Baseline & Motion Sensing
  setMotionDetection(true);
  usbSerial.println("[SYSTEM READY] Parked Mode Monitoring Active.");
}

void loop() {
  // 1. Process inbound 2FA disarm commands or mode updates from Notehub
  checkInboundNotes();

  // 2. Fetch remote configuration shifts (e.g. Mode changes from Web Dashboard)
  checkEnvVars();

  // 3. Monitor tilt movements and geofence conditions
  pollOrientationAndGeofence();

  // 4. Handle 2FA Timer Expiration & Active Tracking State Machine
  if (currentState == STATE_AWAITING_2FA) {
    // Non-blocking location check during 2FA window
    updateCachedLocation(false);

    if (millis() - twoFaStartTime >= TWO_FA_TIMEOUT_MS) {
      usbSerial.println("[ALERT] 2FA Timer Expired! Security Breach Triggered.");
      currentState = STATE_TRACKING_BREACH;
      lastTrackingTime = millis();

      // Trigger high priority security breach alert
      sendAlertNote("security_breach");
    }
  } 
  else if (currentState == STATE_TRACKING_BREACH) {
    // ONLY push 2-minute tracking updates when in active SECURITY BREACH
    if (millis() - lastTrackingTime >= TRACKING_INTERVAL_MS) {
      lastTrackingTime = millis();
      
      usbSerial.println("[TRACKING] Polling GPS fix for 2-minute stolen vehicle update...");
      updateCachedLocation(true); // Request active GPS fix
      sendAlertNote("tracking_update");
    }
  }

  delay(1000);
}

// Retrieve cached location from Notecard without blocking execution
void updateCachedLocation(bool waitForLock) {
  if (waitForLock) {
    J *reqFix = notecard.newRequest("card.location");
    notecard.sendRequest(reqFix);
    delay(2000);
  }

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

// Configure Accelerometer Sensitivity and Calibration Baseline
void setMotionDetection(bool enable) {
  J *req = notecard.newRequest("card.motion.mode");
  JAddBoolToObject(req, "start", enable);
  JAddNumberToObject(req, "sensitivity", 2);
  notecard.sendRequest(req);

  delay(500);

  // Capture orientation baseline
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

// Poll Accelerometer Orientation & Geofence Boundaries
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

        // Calculate delta orientation change
        double delta = abs(curX - baselineX) + abs(curY - baselineY) + abs(curZ - baselineZ);
        if (delta > 0.45) { // Sensitivity threshold
          char baseStr[64], curStr[64];
          snprintf(baseStr, sizeof(baseStr), "X:%.1f Y:%.1f Z:%.1f", baselineX, baselineY, baselineZ);
          snprintf(curStr, sizeof(curStr), "X:%.1f Y:%.1f Z:%.1f", curX, curY, curZ);

          usbSerial.printf("[ALERT] Motion Triggered! Delta: %.2f\n", delta);

          // 1. Send immediate alert note with current cached GPS
          sendAlertNote("parked_tilt_moved", baseStr, curStr);

          // 2. Start 2-Minute 2FA Countdown Window
          currentState = STATE_AWAITING_2FA;
          twoFaStartTime = millis();
        }
      }
    }
    notecard.deleteResponse(rsp);
  }
  else if (currentMode == MODE_BORROWER && borrowerHomeSet) {
    updateCachedLocation(false);
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

// Queue and Sync Event Notes to Notehub (Immediate Non-Blocking Cellular Push)
void sendAlertNote(const char *eventType, const char *baselineStr, const char *currentStr, double extraNum) {
  J *req = notecard.newRequest("note.add");
  JAddStringToObject(req, "file", "alerts.qo");
  JAddBoolToObject(req, "sync", true); // Force instant transmission to Notehub

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

  usbSerial.printf("[ALERT DISPATCH] Event note '%s' queued and synced to Notehub.\n", eventType);
}

// Process 2FA Verification and Disarm Commands sent back from render server via Notehub
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
        usbSerial.println("[DISARM ACCEPTED] 2FA verified successfully!");
        
        // Reset security states and timers
        currentState = STATE_IDLE;
        geofence30WarningSent = false;
        geofence40BreachSent = false;

        if (newMode && strlen(newMode) > 0) {
          if (strcmp(newMode, "PARKED") == 0) currentMode = MODE_PARKED;
          else if (strcmp(newMode, "OWNER") == 0) currentMode = MODE_OWNER;
          else if (strcmp(newMode, "BORROWER") == 0) currentMode = MODE_BORROWER;
        }

        // Reset accelerometer baseline when returning to PARKED mode
        if (currentMode == MODE_PARKED) {
          setMotionDetection(true);
        }
      }
    }
  }
  notecard.deleteResponse(rsp);
}

// Fetch Remote Environment Variables from Notehub
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

// Haversine formula to compute distance (miles)
double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2) {
  double dLat = (lat2 - lat1) * M_PI / 180.0;
  double dLon = (lon2 - lon1) * M_PI / 180.0;
  double a = pow(sin(dLat / 2.0), 2) +
             cos(lat1 * M_PI / 180.0) * cos(lat2 * M_PI / 180.0) *
             pow(sin(dLon / 2.0), 2);
  double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  return 3958.8 * c;
}