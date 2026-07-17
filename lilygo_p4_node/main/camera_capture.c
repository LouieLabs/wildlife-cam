#include "camera_capture.h"
#include "esp_log.h"

static const char *TAG = "cam";

// ===========================================================================
// BRING-UP PLACEHOLDER -- Phase 1 WIP.
// Real implementation: esp_video / esp_cam_sensor MIPI-CSI pipeline + the P4
// hardware JPEG encoder. Pending verified sensor model + component versions.
// ===========================================================================
bool camera_init(void) {
  ESP_LOGE(TAG, "camera_init: MIPI-CSI pipeline not wired yet (bring-up stub)");
  return false;
}
camera_frame_t camera_capture(void) {
  camera_frame_t f = { .buf = NULL, .len = 0 };
  return f;
}
void camera_return(camera_frame_t *f) { (void)f; }
void camera_deinit(void) {}
