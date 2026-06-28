#pragma once
#include <Arduino.h>

// Serial provisioning (Phase 3, route b). On a cold boot the node prints its MAC
// and listens briefly for setup commands over USB serial. The dashboard's
// "Set up a camera" page (Web Serial) drives this after flashing; you can also
// do it by hand from the Arduino Serial Monitor (newline-terminated lines):
//
//   MAC?                     -> node replies:  MAC <aa:bb:cc:dd:ee:ff>
//   SET halow_ssid <value>   -> HaLow network name      (reply: OK halow_ssid)
//   SET halow_psk  <value>   -> HaLow password (PSK)     (reply: OK halow_psk)
//   SET wifi_ssid  <value>   -> 2.4 GHz network name     (reply: OK wifi_ssid)
//   SET wifi_pass  <value>   -> 2.4 GHz password         (reply: OK wifi_pass)
//   SET mode <halow|wifi|both>-> which radio(s) to use   (reply: OK mode)
//   SET id     <value>       -> device id                (reply: OK id)
//   SET secret <value>       -> device secret            (reply: OK secret)
//   SAVE                     -> write stashed values to NVS (reply: SAVED), stop
//   EXIT                     -> leave provisioning, continue normal boot
//
// HaLow and 2.4 GHz are separate networks with separate credentials; identity
// (id + secret) is shared. "value" is everything after the second space, so
// passwords may contain spaces, '=', etc. (anything but a newline).
//
// Listen up to detectMs for the FIRST command. If one arrives, stay in the
// provisioning loop (resetting an idle timeout) until SAVE/EXIT. Returns true if
// SAVE wrote new config (caller should reboot to apply it); false otherwise.
bool provisioningListen(uint32_t detectMs);
