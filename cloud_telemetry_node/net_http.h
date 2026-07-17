#pragma once
#include <Arduino.h>

#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HalowClient.h>
#include <HalowClientSecure.h>
#include <HalowHTTPClient.h>

// ---------------------------------------------------------------------------
// One HTTP door, two radios.
//
// In plain words: the standard HTTPClient only speaks through the 2.4 GHz
// Wi-Fi radio's sockets, and Heltec's HalowHTTPClient (a mirror-image copy of
// the same class) only speaks through the HaLow module's. The cloud code
// shouldn't have to care which radio got us online, so this thin wrapper
// holds one of each and forwards every call to whichever matches
// netActiveLink(). Only the handful of methods the firmware actually uses
// are wrapped -- extend it if you need more, the two classes' APIs match
// one-for-one.
//
// TLS note: like the code it replaced, https:// URLs skip certificate
// verification (setInsecure) -- acceptable here because every payload that
// matters is separately authenticated (device secret) or hash-verified (OTA
// SHA256). See cloud_telemetry_node/README.md.
//
// Usage (same shape as HTTPClient):
//   NetHttp http;
//   if (!http.begin(url)) return false;     // picks radio + TLS from the URL
//   http.addHeader("Content-Type", "application/json");
//   int code = http.POST(body);
//   http.end();
// ---------------------------------------------------------------------------
class NetHttp {
public:
  // Parse the URL, pick the radio (from netActiveLink()) and the transport
  // (https:// -> TLS, http:// -> plain, like requestUploadUrl always did).
  bool begin(const String &url);

  // Socket-level read timeout. Callable before OR after begin() (the OTA code
  // sets it first); the value is applied to the live client at begin() time.
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
  // The response body as a readable stream (for chunked OTA reads). Both
  // radios' client classes are Streams, so this is radio-agnostic.
  Stream *getStreamPtr();
  void end();

private:
  bool _useHalow = false;
  uint32_t _timeoutMs = 0;   // 0 = leave the library default

  // 2.4 GHz stack
  WiFiClient _wifiPlain;
  WiFiClientSecure _wifiTls;
  HTTPClient _wifiHttp;

  // HaLow stack (mirror classes from the Heltec wifi-halow library)
  HalowClient _halowPlain;
  HalowClientSecure _halowTls;
  HalowHTTPClient _halowHttp;
};
