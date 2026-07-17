#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Network link management: gets the board online over HaLow (long-range,
// sub-GHz) and/or normal 2.4 GHz Wi-Fi, per the provisioned net mode.
//
// In plain words: the board has TWO radios that can reach the internet.
// "HaLow" is the slow-but-far one for deployed cameras in the field; regular
// Wi-Fi is the fast-but-short one, handy on a bench next to your router. The
// provisioned `netMode` ("halow" | "wifi" | "both") says which to use; "both"
// tries HaLow first and falls back to Wi-Fi. Everything downstream (status
// reports, photo uploads, OTA) just asks "am I online?" and doesn't care which
// radio won -- net_http.h hides that difference for HTTP calls.
// ---------------------------------------------------------------------------

// Which radio actually got us online this wake.
enum NetLink {
  NET_LINK_NONE,   // not online
  NET_LINK_WIFI,   // 2.4 GHz Wi-Fi (native ESP32-S3 radio)
  NET_LINK_HALOW,  // Wi-Fi HaLow (onboard HT-HC01 module, sub-GHz)
};

// What happened to the 2.4 GHz radio specifically this wake. The set_wifi
// trial (device_config.h) judges NEW Wi-Fi credentials by whether Wi-Fi
// connected -- but in "both" mode HaLow may win first and Wi-Fi is never
// tried, so "we're online" alone can't judge a Wi-Fi credential change.
enum NetWifiAttempt {
  NET_WIFI_SKIPPED,    // the 2.4 GHz radio wasn't tried this wake
  NET_WIFI_FAILED,     // tried and did not connect
  NET_WIFI_CONNECTED,  // tried and connected
};

// Get online per g_cfg.netMode. Returns true once EITHER radio is connected.
// wifiTimeoutMs bounds the 2.4 GHz attempt; the HaLow attempt uses
// HALOW_CONNECT_TIMEOUT_MS from node_config.h (sub-GHz association is slower).
bool netConnect(uint32_t wifiTimeoutMs = 15000);

// Which radio is carrying traffic right now (NET_LINK_NONE if offline).
NetLink netActiveLink();

// True while the active link is still connected. Use this instead of
// WiFi.status() so HaLow links are checked too.
bool netIsConnected();

// Signal strength (dBm) of the ACTIVE link, or 0 when unknown/offline.
int netRSSI();

// Outcome of this wake's 2.4 GHz attempt (see enum comment above).
NetWifiAttempt netWifiAttempt();

// Turn the radios off before deep sleep (lowest current draw). The HaLow
// module has no vendor stop API -- deep sleep resets it along with the chip.
void netShutdown();
