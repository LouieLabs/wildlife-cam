#pragma once
#include <stdbool.h>
#include <stdint.h>

// USB-serial provisioning REPL -- P4 port of the HT-HC33 provisioning module.
// The dashboard's "Set up a camera" page (Web Serial) speaks this exact
// protocol, so the SAME browser tool provisions both board types:
//
//   MAC?                       -> MAC <aa:bb:cc:dd:ee:ff>
//   SET wifi_ssid <value>      -> OK wifi_ssid       (likewise wifi_pass,
//   SET halow_ssid|halow_psk|mode|id|secret <value>)
//   SAVE                       -> SAVED (persist to NVS), stop
//   EXIT                       -> OK exit, continue boot
//
// Listens up to detect_ms for the FIRST command; once one arrives, stays in
// the loop (idle timeout) until SAVE/EXIT. Returns true if SAVE succeeded --
// caller should reboot to apply.
bool provisioning_listen(uint32_t detect_ms);
