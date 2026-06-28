#pragma once
#include <Arduino.h>

// Serial provisioning (Phase 3, route b). On a cold boot the node prints its MAC
// and listens briefly for setup commands over USB serial. The dashboard's
// "Set up a camera" page (Web Serial) drives this after flashing; you can also
// do it by hand from the Arduino Serial Monitor (newline-terminated lines):
//
//   MAC?                 -> node replies:  MAC <aa:bb:cc:dd:ee:ff>
//   SET ssid <value>     -> stash Wi-Fi name      (reply: OK ssid)
//   SET pass <value>     -> stash Wi-Fi password  (reply: OK pass)
//   SET id <value>       -> stash device id       (reply: OK id)
//   SET secret <value>   -> stash device secret   (reply: OK secret)
//   SAVE                 -> write stashed values to NVS (reply: SAVED) and stop
//   EXIT                 -> leave provisioning and continue normal boot
//
// "value" is everything after the second space, so Wi-Fi passwords may contain
// spaces, '=', etc. (anything but a newline).
//
// Listen up to detectMs for the FIRST command. If one arrives, stay in the
// provisioning loop (resetting an idle timeout) until SAVE/EXIT. Returns true if
// SAVE wrote new config (caller should reboot to apply it); false otherwise.
bool provisioningListen(uint32_t detectMs);
