#include "net_http.h"
#include "net_link.h"

bool NetHttp::begin(const String &url) {
  _useHalow = (netActiveLink() == NET_LINK_HALOW);
  bool secure = url.startsWith("https:");

  // Apply a caller-set timeout to the client we're about to use. The
  // libraries take uint16_t ms, so clamp rather than let a big value wrap
  // (120000 would silently become 54464).
  uint16_t t = (_timeoutMs > 65535UL) ? 65535 : (uint16_t)_timeoutMs;

  if (_useHalow) {
    if (secure) _halowTls.setInsecure();   // skip cert check; see header comment
    if (_timeoutMs) _halowHttp.setTimeout(t);
    return _halowHttp.begin(secure ? (HalowClient &)_halowTls : _halowPlain, url);
  }
  if (secure) _wifiTls.setInsecure();      // skip cert check; see header comment
  if (_timeoutMs) _wifiHttp.setTimeout(t);
  return _wifiHttp.begin(secure ? (WiFiClient &)_wifiTls : _wifiPlain, url);
}

void NetHttp::setTimeout(uint32_t ms) {
  _timeoutMs = ms;   // stored; applied to the chosen client in begin()
}

void NetHttp::addHeader(const String &name, const String &value) {
  if (_useHalow) _halowHttp.addHeader(name, value);
  else           _wifiHttp.addHeader(name, value);
}

int NetHttp::GET() {
  return _useHalow ? _halowHttp.GET() : _wifiHttp.GET();
}

int NetHttp::POST(const String &body) {
  return _useHalow ? _halowHttp.POST(body) : _wifiHttp.POST(body);
}

int NetHttp::PUT(const String &body) {
  return _useHalow ? _halowHttp.PUT(body) : _wifiHttp.PUT(body);
}

int NetHttp::sendRequest(const char *type, uint8_t *payload, size_t size) {
  return _useHalow ? _halowHttp.sendRequest(type, payload, size)
                   : _wifiHttp.sendRequest(type, payload, size);
}

int NetHttp::sendRequest(const char *type, Stream *stream, size_t size) {
  return _useHalow ? _halowHttp.sendRequest(type, stream, size)
                   : _wifiHttp.sendRequest(type, stream, size);
}

String NetHttp::getString() {
  return _useHalow ? _halowHttp.getString() : _wifiHttp.getString();
}

int NetHttp::getSize() {
  return _useHalow ? _halowHttp.getSize() : _wifiHttp.getSize();
}

bool NetHttp::connected() {
  return _useHalow ? _halowHttp.connected() : _wifiHttp.connected();
}

Stream *NetHttp::getStreamPtr() {
  if (_useHalow) return _halowHttp.getStreamPtr();
  return _wifiHttp.getStreamPtr();
}

void NetHttp::end() {
  if (_useHalow) _halowHttp.end();
  else           _wifiHttp.end();
}
