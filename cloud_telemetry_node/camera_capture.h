#pragma once
#include "esp_camera.h"

// Camera helpers for the Heltec HT-HC33 (OV3660). The pin mapping mirrors the
// factory configuration used by the live-stream sketch so we don't fight
// Heltec's wiring. We only power the camera up when we actually need a photo.

// Initialise the camera. Returns true on success.
bool cameraInit();

// Grab one JPEG frame. Returns the frame buffer (or nullptr). The CALLER must
// hand it back with cameraReturn() when done.
camera_fb_t *cameraCapture();

// Return a frame buffer obtained from cameraCapture().
void cameraReturn(camera_fb_t *fb);

// Power the camera back down (we do this before deep sleep).
void cameraDeinit();
