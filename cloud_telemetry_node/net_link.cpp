#include "net_link.h"
#include "node_config.h"
#include "device_config.h"

#include <WiFi.h>
#include <HaLow.h>   // Heltec wifi-halow library (HT-HC01 module on the HT-HC33)

// ---------------------------------------------------------------------------
// Module state: which radio won this wake. Deep sleep resets the chip, so
// this is per-wake state -- no need to persist it.
// ---------------------------------------------------------------------------
static NetLink        s_activeLink  = NET_LINK_NONE;
static NetWifiAttempt s_wifiAttempt = NET_WIFI_SKIPPED;
static bool           s_halowInited = false;

// ---------------------------------------------------------------------------
// 2.4 GHz Wi-Fi (native ESP32-S3 radio). Moved unchanged from cloud_backend.cpp.
// ---------------------------------------------------------------------------
static bool wifiStaConnect(const String &ssid, const String &pass, uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.printf("[wifi] connecting to %s", ssid.c_str());
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Wi-Fi HaLow (onboard HT-HC01 over SPI). API per the vendor examples in
// HelTecAutomation/ESP_HaLow -> libraries/wifi-halow (UDP_Client_lowpower,
// BasicHttpsClient): init(region) once, begin(ssid, passphrase), then poll
// status() until WL_CONNECTED. HaLow networks authenticate with SAE (WPA3's
// password scheme), which is the library's default security type.
// ---------------------------------------------------------------------------
static bool halowConnect(const String &ssid, const String &psk, uint32_t timeoutMs) {
  if (HaLow.status() == WL_CONNECTED) return true;

  if (!s_halowInited) {
    HaLow.init(HALOW_REGION);   // loads the regulatory channel list; once per boot
    s_halowInited = true;
  }

  // SAE is the library's default security type; pass HALOW_REGION explicitly so
  // begin() can never disagree with init() (its own default is hardcoded "US").
  HaLow.begin(ssid.c_str(), psk.c_str(), MMWLAN_SAE, HALOW_REGION);
  Serial.printf("[halow] connecting to %s", ssid.c_str());
  uint32_t start = millis();
  // WL_CONNECTED is the vendor-blessed "ready" check; also insist on a real IP
  // so the first HTTP call never races DHCP.
  while ((HaLow.status() != WL_CONNECTED || HaLow.localIP() == IPAddress()) &&
         millis() - start < timeoutMs) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (HaLow.status() == WL_CONNECTED && HaLow.localIP() != IPAddress()) {
    Serial.printf("[halow] connected, IP %s (RSSI %d dBm)\n",
                  HaLow.localIP().toString().c_str(), (int)HaLow.RSSI());
    return true;
  }
  Serial.println("[halow] connect timed out");
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Get online per the provisioned net mode. HaLow and 2.4 GHz are separate
// radios/networks; "both" tries HaLow first (production long-range) then falls
// back to 2.4 GHz.
bool netConnect(uint32_t wifiTimeoutMs) {
  if (netIsConnected()) return true;

  s_activeLink  = NET_LINK_NONE;
  s_wifiAttempt = NET_WIFI_SKIPPED;

  bool wantHalow = (g_cfg.netMode == "halow" || g_cfg.netMode == "both");
  bool wantWifi  = (g_cfg.netMode == "wifi"  || g_cfg.netMode == "both");
  bool tried = false;

  if (wantHalow) {
    if (g_cfg.halowSsid.length()) {
      tried = true;
      if (halowConnect(g_cfg.halowSsid, g_cfg.halowPsk, HALOW_CONNECT_TIMEOUT_MS)) {
        s_activeLink = NET_LINK_HALOW;
        return true;
      }
    } else {
      Serial.println("[net] HaLow wanted but no HaLow SSID provisioned -> skipping");
    }
  }

  if (wantWifi && g_cfg.wifiSsid.length()) {
    tried = true;
    bool ok = wifiStaConnect(g_cfg.wifiSsid, g_cfg.wifiPass, wifiTimeoutMs);
    s_wifiAttempt = ok ? NET_WIFI_CONNECTED : NET_WIFI_FAILED;
    if (ok) {
      s_activeLink = NET_LINK_WIFI;
      return true;
    }
  }

  Serial.println(tried ? "[net] all configured radios failed -> offline this wake"
                       : "[net] no usable network configured -> cannot connect");
  return false;
}

NetLink netActiveLink() {
  return s_activeLink;
}

bool netIsConnected() {
  switch (s_activeLink) {
    case NET_LINK_WIFI:  return WiFi.status() == WL_CONNECTED;
    case NET_LINK_HALOW: return HaLow.isConnected();
    default:             return false;
  }
}

int netRSSI() {
  switch (s_activeLink) {
    case NET_LINK_WIFI:  return WiFi.RSSI();
    case NET_LINK_HALOW: return (int)HaLow.RSSI();
    default:             return 0;   // unknown -- callers treat 0 as "no reading"
  }
}

NetWifiAttempt netWifiAttempt() {
  return s_wifiAttempt;
}

void netShutdown() {
  // 2.4 GHz off (harmless if it was never started). The HaLow module has no
  // stop API in the vendor library; the deep-sleep reset takes it down.
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  s_activeLink = NET_LINK_NONE;
}
