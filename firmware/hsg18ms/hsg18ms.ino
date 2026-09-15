#include <Notecard.h>

#define serialNotecard Serial1

Notecard notecard;

// State management variables
String currentMode = "PARKED";
bool isBreached = false;
unsigned long tiltDetectedTime = 0;
const unsigned long TWO_MINUTE_TIMEOUT = 120000; // 2 minutes in ms

// Tilt Baseline tracking
float baselineX = 0, baselineY = 0, baselineZ = 0;
bool baselineSet = false;

void setup() {
    Serial.begin(115200);
    serialNotecard.begin(115200);
    notecard.begin(serialNotecard);

    // Configure Notecard to use continuous cellular connection for instant alerts
    J *req = notecard.newRequest("hub.set");
    if (req != NULL) {
        JAddStringToObject(req, "mode", "continuous");
        JAddBoolToObject(req, "sync", true);
        notecard.sendRequest(req);
    }

    // Send boot location/online notice
    sendBootEvent();
}

void loop() {
    // 1. Check for incoming notes from Render Server (e.g., inbound.qi for 2FA verification)
    checkInboundNotes();

    // 2. Read environment variable changes from Notehub
    fetchEnvironmentVariables();

    // 3. Monitor tilt if system is in PARKED mode
    if (currentMode == "PARKED" && !isBreached) {
        monitorParkedTilt();
    }

    // 4. Track 2-Minute Security Breach Window
    if (tiltDetectedTime > 0 && !isBreached) {
        if (millis() - tiltDetectedTime >= TWO_MINUTE_TIMEOUT) {
            triggerBreachEvent();
        }
    }

    // 5. If breached or tracking required, push GPS coordinates regularly
    if (isBreached) {
        sendGpsTrackingUpdate();
        delay(10000); // Send updates every 10 seconds during breach
    } else {
        delay(1000);
    }
}

void triggerParkedTiltEvent(String baselineStr, String currentStr) {
    J *req = notecard.newRequest("note.add");
    if (req != NULL) {
        JAddStringToObject(req, "file", "tilt.qi");
        JAddBoolToObject(req, "sync", true); // INSTANT SYNC TO NOTEHUB AND WEBHOOK

        J *body = JCreateObject();
        JAddStringToObject(body, "event", "parked_tilt_moved");
        JAddStringToObject(body, "baseline", baselineStr.c_str());
        JAddStringToObject(body, "current", currentStr.c_str());
        JAddStringToObject(body, "mode", currentMode.c_str());
        JAddItemToObject(req, "body", body);

        notecard.sendRequest(req);
        tiltDetectedTime = millis();
        Serial.println("IMMEDIATE ALERT: Parked tilt detected! 2FA timer started.");
    }
}

void triggerBreachEvent() {
    isBreached = true;
    tiltDetectedTime = 0; // Clear timer

    J *req = notecard.newRequest("note.add");
    if (req != NULL) {
        JAddStringToObject(req, "file", "breach.qi");
        JAddBoolToObject(req, "sync", true);

        J *body = JCreateObject();
        JAddStringToObject(body, "event", "security_breach");
        JAddStringToObject(body, "mode", currentMode.c_str());
        JAddItemToObject(req, "body", body);

        notecard.sendRequest(req);
        Serial.println("CRITICAL: 2FA Timeout Exceeded! Security Breach triggered.");
    }
}

void monitorParkedTilt() {
    J *req = notecard.newRequest("card.motion");
    if (req == NULL) return;

    J *rsp = notecard.requestAndResponse(req);

    if (rsp != NULL) {
        if (JGetBool(rsp, "motion")) {
            float x = JGetNumber(rsp, "x");
            float y = JGetNumber(rsp, "y");
            float z = JGetNumber(rsp, "z");

            if (!baselineSet) {
                baselineX = x;
                baselineY = y;
                baselineZ = z;
                baselineSet = true;
            } else {
                // Check if movement exceeds threshold delta
                if (abs(x - baselineX) > 0.25 || abs(y - baselineY) > 0.25 || abs(z - baselineZ) > 0.25) {
                    String baseStr = String(baselineX) + "," + String(baselineY) + "," + String(baselineZ);
                    String currStr = String(x) + "," + String(y) + "," + String(z);
                    triggerParkedTiltEvent(baseStr, currStr);
                }
            }
        }
        notecard.deleteResponse(rsp);
    }
}

void checkInboundNotes() {
    J *req = notecard.newRequest("note.get");
    if (req == NULL) return;

    JAddStringToObject(req, "file", "inbound.qi");
    JAddBoolToObject(req, "delete", true);

    J *rsp = notecard.requestAndResponse(req);

    if (rsp != NULL) {
        if (!NoteResponseError(rsp)) {
            J *body = JGetObject(rsp, "body");
            if (body != NULL) {
                bool verified = JGetBool(body, "verified");
                if (verified) {
                    String newMode = JGetString(body, "mode");
                    currentMode = newMode;
                    isBreached = false;
                    tiltDetectedTime = 0;
                    baselineSet = false; // Reset baseline for next parked event
                    Serial.println("2FA DISARM VERIFIED VIA MCU: Mode set to " + newMode);
                }
            }
        }
        notecard.deleteResponse(rsp);
    }
}

void fetchEnvironmentVariables() {
    J *req = notecard.newRequest("env.get");
    if (req == NULL) return;

    J *rsp = notecard.requestAndResponse(req);

    if (rsp != NULL) {
        if (!NoteResponseError(rsp)) {
            J *env = JGetObject(rsp, "body");
            if (env != NULL) {
                const char* modeStr = JGetString(env, "app_mode");
                if (modeStr != NULL && strlen(modeStr) > 0) {
                    currentMode = String(modeStr);
                }
            }
        }
        notecard.deleteResponse(rsp);
    }
}

void sendGpsTrackingUpdate() {
    J *req = notecard.newRequest("card.location");
    float lat = 0, lon = 0;

    if (req != NULL) {
        J *rsp = notecard.requestAndResponse(req);
        if (rsp != NULL) {
            lat = JGetNumber(rsp, "lat");
            lon = JGetNumber(rsp, "lon");
            notecard.deleteResponse(rsp);
        }
    }

    J *noteReq = notecard.newRequest("note.add");
    if (noteReq != NULL) {
        JAddStringToObject(noteReq, "file", "tracking.qi");
        JAddBoolToObject(noteReq, "sync", true);

        J *body = JCreateObject();
        JAddStringToObject(body, "event", "tracking_update");
        JAddStringToObject(body, "mode", currentMode.c_str());
        JAddNumberToObject(body, "lat", lat);
        JAddNumberToObject(body, "lon", lon);
        JAddItemToObject(noteReq, "body", body);

        notecard.sendRequest(noteReq);
    }
}

void sendBootEvent() {
    J *req = notecard.newRequest("note.add");
    if (req != NULL) {
        JAddStringToObject(req, "file", "boot.qi");
        JAddBoolToObject(req, "sync", true);

        J *body = JCreateObject();
        JAddStringToObject(body, "event", "boot_location_captured");
        JAddStringToObject(body, "mode", "PARKED");
        JAddItemToObject(req, "body", body);

        notecard.sendRequest(req);
    }
}