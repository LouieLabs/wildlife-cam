#include "dev_mode.h"
#include "node_config.h"
#include "device_config.h"
#include "secrets.h"
#include "cloud_backend.h"     // readBatteryPercent()
#include "camera_capture.h"

#include <WiFi.h>
#include "esp_http_server.h"

static httpd_handle_t s_httpd = NULL;

bool devModeRequested(uint32_t windowMs) {
  Serial.printf("\n[boot] DEV MODE? Press any key within %lu s (a computer is connected)...\n",
                (unsigned long)(windowMs / 1000));
  while (Serial.available()) Serial.read();   // flush any stale bytes first
  uint32_t start = millis();
  while (millis() - start < windowMs) {
    if (Serial.available()) {
      while (Serial.available()) Serial.read();
      return true;
    }
    delay(50);
  }
  Serial.println("[boot] no key -> FIELD MODE");
  return false;
}

// GET /snapshot -> a fresh JPEG from the camera.
static esp_err_t snapshot_handler(httpd_req_t *req) {
  camera_fb_t *fb = cameraCapture();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  cameraReturn(fb);
  return res;
}

// GET / -> a simple page that auto-refreshes the snapshot (a poor-man's stream).
static esp_err_t index_handler(httpd_req_t *req) {
  char html[700];
  snprintf(html, sizeof(html),
    "<!DOCTYPE html><html><head><meta name=viewport "
    "content='width=device-width,initial-scale=1'><title>%s (dev)</title></head>"
    "<body style='font-family:system-ui;text-align:center;margin:16px'>"
    "<h2>%s &mdash; DEV MODE</h2>"
    "<p>Battery: %d%% &middot; AP IP: %s</p>"
    "<img id=v src='/snapshot' style='max-width:100%%;border:1px solid #ccc;border-radius:8px'>"
    "<script>setInterval(function(){document.getElementById('v').src='/snapshot?'+Date.now();},1500);</script>"
    "</body></html>",
    g_cfg.deviceId.c_str(), g_cfg.deviceId.c_str(), readBatteryPercent(), WiFi.softAPIP().toString().c_str());
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, html, strlen(html));
}

static void startDevServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  if (httpd_start(&s_httpd, &config) != ESP_OK) {
    Serial.println("[dev] web server FAILED to start");
    return;
  }
  httpd_uri_t idx = {};
  idx.uri = "/"; idx.method = HTTP_GET; idx.handler = index_handler;
  httpd_uri_t snap = {};
  snap.uri = "/snapshot"; snap.method = HTTP_GET; snap.handler = snapshot_handler;
  httpd_register_uri_handler(s_httpd, &idx);
  httpd_register_uri_handler(s_httpd, &snap);
  Serial.println("[dev] web server started");
}

void runDevMode() {
  Serial.println("[dev] === DEV MODE: 2.4 GHz Wi-Fi hotspot + camera website ===");

  // Self-contained hotspot so offsite dev needs no network/gateway: connect your
  // laptop/phone to this Wi-Fi, then open the printed address.
  String ssid = String("wildcam-") + g_cfg.deviceId;
  WiFi.mode(WIFI_AP);
  WiFi.softAP(ssid.c_str(), DEV_AP_PASSWORD);
  Serial.printf("[dev] join Wi-Fi '%s' (pw: %s)\n", ssid.c_str(), DEV_AP_PASSWORD);
  Serial.printf("[dev] >>> then open http://%s/ <<<\n", WiFi.softAPIP().toString().c_str());

  if (!cameraInit()) Serial.println("[dev] camera init failed (snapshots unavailable)");
  startDevServer();

  // Stay awake serving (the HTTP server runs in its own task). We never deep
  // sleep in dev mode.
  for (;;) delay(1000);
}
