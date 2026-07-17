#pragma once
#include <Arduino.h>

#include <HalowClient.h>
#include <HalowClientSecure.h>
#include <HalowHTTPClient.h>

// ---------------------------------------------------------------------------
// One HTTP door for both radios -- built on the HaLow HTTP classes ONLY.
//
// In plain words: this wrapper is how all the cloud code makes web requests,
// whether the board got online over HaLow or over regular 2.4 GHz Wi-Fi. It
// uses Heltec's Halow* classes for BOTH radios -- and that's not laziness,
// it's forced (see below). Those classes talk plain internet sockets, so they
// carry traffic over whichever radio is connected.
//
// WHY ONLY THE HALOW CLASSES -- do not "fix" this by adding the stock ones:
// on the Heltec ESP_HaLow core, the stock <HTTPClient.h>/<WiFiClientSecure.h>
// and the HaLow copies CANNOT coexist in one sketch, at two levels:
//   1. <HTTPClient.h> and <HalowHTTPClient.h> both define the same global
//      HTTP_CODE_* enum -> compile error if any file includes both.
//   2. The WiFiClientSecure library and the wifi-halow library each compile
//      their own ssl_client.cpp with IDENTICAL function names
//      (start_ssl_client, ...) -> duplicate-symbol link error if a sketch
//      pulls in both libraries at all. Using <HaLow.h> anywhere (net_link.cpp
//      does) already pulls in wifi-halow, so the stock TLS/HTTP libs are
//      off-limits for this whole sketch.
// The Halow* classes are file-copies of the stock ones running on generic
// lwIP sockets (their DNS helper calls plain dns_gethostbyname -- verified in
// libheltec_halow.a), so they work over the 2.4 GHz interface too. Full story:
// docs/HALOW_UPLINK.md.
//
// TLS note: like the code it replaced, https:// URLs skip certificate
// verification (setInsecure) -- acceptable here because every payload that
// matters is separately authenticated (device secret) or hash-verified (OTA
// SHA256). See cloud_telemetry_node/README.md.
//
// Usage (same shape as the stock HTTPClient):
//   NetHttp http;
//   if (!http.begin(url)) return false;     // picks TLS vs plain from the URL
//   http.addHeader("Content-Type", "application/json");
//   int code = http.POST(body);
//   http.end();
// ---------------------------------------------------------------------------
class NetHttp {
public:
  // Parse the URL and pick the transport (https:// -> TLS, http:// -> plain,
  // like requestUploadUrl always did). Works over whichever radio is up.
  bool begin(const String &url);

  // Socket-level read timeout. Callable before OR after begin() (the OTA code
  // sets it first); the value is applied at begin() time.
  void setTimeout(uint32_t ms);

  void addHeader(const String &name, const String &value);
  int GET();
  int POST(const String &body);
  int PUT(const String &body);
  int sendRequest(const char *type, uint8_t *payload, size_t size);
  int sendRequest(const char *type, Stream *stream, size_t size);
  String getString();
  int getSize();
  bool connected();
  // The response body as a readable stream (for chunked OTA reads).
  Stream *getStreamPtr();
  void end();

private:
  uint32_t _timeoutMs = 0;   // 0 = leave the library default
  HalowClient _plain;
  HalowClientSecure _tls;
  HalowHTTPClient _http;
};
