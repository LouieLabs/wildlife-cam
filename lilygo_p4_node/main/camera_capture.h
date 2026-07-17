#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// MIPI-CSI camera -> JPEG still for the T-Halow-P4 (esp_video / esp_cam_sensor
// per HARDWARE.md: native MIPI-CSI drivers, no legacy esp32-camera DVP code).
//
// Contract mirrors the S3 build: power the sensor only while photographing;
// warm up a few frames so auto-exposure settles; hand back a JPEG buffer the
// caller must release.

typedef struct {
  uint8_t *buf;   // JPEG bytes (owned by the driver until camera_return)
  size_t len;
} camera_frame_t;

// Init the sensor + pipeline. Returns false on probe/driver failure.
// Retries internally with a sensor power-cycle (the 0x105 lesson from the S3
// fleet: transient probe failures deserve a second chance before giving up).
bool camera_init(void);

// Capture one JPEG frame. NULL buf on failure.
camera_frame_t camera_capture(void);

// Return a frame from camera_capture().
void camera_return(camera_frame_t *f);

// Power the camera pipeline down before sleep.
void camera_deinit(void);
