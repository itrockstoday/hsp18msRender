#include <Notecard.h>
#include <Wire.h>
#include <math.h>

#define PRODUCT_UID "com.techbyjr.jose:hspg18ms"
// Updated: 2-Minute (120,000 ms) window to switch to your 2FA app and enter your code
#define PIN_TIMEOUT_MS 120000 
#define usbSerial Serial

Notecard notecard;

enum OperatingMode {
  MODE_PARKED,   
  MODE_OWNER,    
  MODE_BORROWER  
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
unsigned long lastMotionTimestamp = 0;

double borrowerOriginLat = 0.0;
double borrowerOriginLon = 0.0;

void sendAlertNote(const char *eventType, const char *extraInfo = NULL, double extraNum = 0.0);
void checkIncoming2FA();
void syncOperatingModeFromNotehub();
bool waitForGpsLock(double &lat, double &lon, int maxWaitSeconds);
double calculateDistanceMiles(double lat1, double lon1, double lat2, double lon2);

void setup() {
  delay(2500);
  usbSerial.begin(115200);

  Wire.begin();
  notecard.begin();
  notecard.setDebugOutputStream(usbSerial);

  J *req = notecard.newRequest("hub.set");
  JAddStringToObject(req, "product", PRODUCT_UID);
  JAddStringToObject(req, "mode", "continuous");
  JAddBoolToObject(req, "sync", true);
  notecard.sendRequest(req);

  req = notecard.newRequest("card.location.mode");
  JAddStringToObject(req, "mode", "periodic");
  JAddNumberToObject(req, "seconds", 15);
  JAddBoolToObject(req, "active", true);
  JAddNumberToObject(req, "max", 10);
  notecard.sendRequest(req);

  req = notecard.newRequest("card.motion.mode");
  JAddNumberToObject(req, "sensitivity", 1);
  JAddBoolToObject(req, "orientation", true);
  JAddBoolToObject(req, "start", true);
  notecard.sendRequest(req);

  syncOperatingModeFromNotehub();

  usbSerial.println("\n[BOOT] Connecting to Notehub and capturing location...");

  double initialLat = 0.0, initialLon = 0.0;
  if (waitForGpsLock(initialLat, initialLon, 45)) {
    if (currentMode == MODE_BORROWER) {
      borrowerOriginLat = initialLat;
      borrowerOriginLon = initialLon;
      usbSerial.println("[BORROWER MODE] Geofence Pin set at current location.");
    }
    sendAlertNote("boot_location_captured");
  }
}

void loop() {
  syncOperatingModeFromNotehub();

  if (currentMode == MODE_OWNER) {
    delay(5000);
    return;
  }

  if (currentState == STATE_IDLE) {
    J *req = notecard.newRequest("card.motion");
    J *rsp = notecard.requestAndResponse(req);

    if (rsp && !NoteResponseError(rsp)) {
      unsigned long currentMotion = JGetNumber(rsp, "motion");
      const char *orientation = JGetString(rsp, "status");

      if (lastMotionTimestamp == 0 && currentMotion > 0) {
        lastMotionTimestamp = currentMotion;
      }

      if (currentMotion > lastMotionTimestamp) {
        lastMotionTimestamp = currentMotion;
        usbSerial.println("\n[ALERT] Movement Detected! 2-Minute 2FA Window Started...");
        sendAlertNote("device_moved");

        currentState = STATE_AWAITING_2FA;
        motionDetectedTime = millis();
      }
      else if (orientation && (strcmp(orientation, "face-down") == 0 || 
                               strcmp(orientation, "tilt-left") == 0 || 
                               strcmp(orientation, "tilt-right") == 0)) {
        
        usbSerial.print("\n[WARNING] Vehicle Tilt Detected: ");
        usbSerial.println(orientation);
        sendAlertNote("vehicle_tilt_warning", orientation);

        currentState = STATE_AWAITING_2FA;
        motionDetectedTime = millis();
      }
    }
    notecard.deleteResponse(rsp);

    if (currentMode == MODE_BORROWER && borrowerOriginLat != 0.0) {
      double currentLat = 0.0, currentLon = 0.0;
      if (waitForGpsLock(currentLat, currentLon, 5)) {
        double distMiles = calculateDistanceMiles(borrowerOriginLat, borrowerOriginLon, currentLat, currentLon);
        if (distMiles > 40.0) {
          usbSerial.printf("\n[GEOFENCE BREACH] Distance: %.2f miles! Triggering alert.\n", distMiles);
          sendAlertNote("geofence_breach", NULL, distMiles);
          currentState = STATE_TRACKING_BREACH;
          lastPeriodicTrackTime = millis();
        }
      }
    }
  }

  // 2-MINUTE TIMEOUT EVALUATION
  if (currentState == STATE_AWAITING_2FA) {
    checkIncoming2FA();

    if (millis() - motionDetectedTime > PIN_TIMEOUT_MS) {
      usbSerial.println("\n[SECURITY BREACH] 2-Minute Timeout Expired! Activating tracking mode.");
      sendAlertNote("security_breach");

      currentState = STATE_TRACKING_BREACH;
      lastPeriodicTrackTime = millis();
    }
  }

  if (currentState == STATE_TRACKING_BREACH) {
    checkIncoming2FA();

    if (millis() - lastPeriodicTrackTime >= 120000) {
      usbSerial.println("\n[TRACKING] Dispatching updated 1m GPS location...");
      sendAlertNote("tracking_update");
      lastPeriodicTrackTime = millis();
    }
  }

  delay(2000);
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

void sendAlertNote(const char *eventType, const char *extraInfo, double extraNum) {
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

  if (extraInfo != NULL) JAddStringToObject(body, "orientation", extraInfo);
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
      usbSerial.println("[SECURITY] 2FA Verified. System disarmed.");
      currentState = STATE_IDLE;
    }
  }
  notecard.deleteResponse(rsp);
}