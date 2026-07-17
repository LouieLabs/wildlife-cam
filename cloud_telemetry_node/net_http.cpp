#include "net_http.h"

bool NetHttp::begin(const String &url) {
  bool secure = url.startsWith("https:");

  // Apply a caller-set timeout. The library takes uint16_t ms, so clamp
  // rather than let a big value wrap (120000 would silently become 54464).
  if (_timeoutMs) {
    uint16_t t = (_timeoutMs > 65535UL) ? 65535 : (uint16_t)_timeoutMs;
    _http.setTimeout(t);
  }

  if (secure) {
    _tls.setInsecure();   // skip cert check; see header comment
    return _http.begin(_tls, url);
  }
  return _http.begin(_plain, url);
}

void NetHttp::setTimeout(uint32_t ms) {
  _timeoutMs = ms;   // stored; applied in begin()
}

void NetHttp::addHeader(const String &name, const String &value) {
  _http.addHeader(name, value);
}

int NetHttp::GET() {
  return _http.GET();
}

int NetHttp::POST(const String &body) {
  return _http.POST(body);
}

int NetHttp::PUT(const String &body) {
  return _http.PUT(body);
}

int NetHttp::sendRequest(const char *type, uint8_t *payload, size_t size) {
  return _http.sendRequest(type, payload, size);
}

int NetHttp::sendRequest(const char *type, Stream *stream, size_t size) {
  return _http.sendRequest(type, stream, size);
}

String NetHttp::getString() {
  return _http.getString();
}

int NetHttp::getSize() {
  return _http.getSize();
}

bool NetHttp::connected() {
  return _http.connected();
}

Stream *NetHttp::getStreamPtr() {
  return _http.getStreamPtr();
}

void NetHttp::end() {
  _http.end();
}
