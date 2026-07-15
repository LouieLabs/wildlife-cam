# LouieLabs Hardware Manifest

## Target Board 1: Heltec HT-HC33
- **Core MCU:** ESP32-S3R8 (8MB PSRAM, 16MB Flash)
- **Onboard Camera:** OV3660 via 24-pin FPC connector
- **HaLow Module:** Onboard HT-HC01 (Communicates over internal SPI/Serial)
- **Rule:** When generating code for this board, ensure the camera pin mapping aligns with Heltec's factory ESP32-S3 camera configuration. Do not overwrite the standard I2C pins used for auto-exposure/gain control loops.

## Target Board 2: Lilygo T-Halow-P4
- **Core MCU:** ESP32-P4 (High-performance RISC-V, 8MB PSRAM, 16MB Flash)
- **Onboard Camera Bus:** MIPI-CSI (Hardware H.264 encoding enabled)
- **HaLow Companion Chip:** Onboard ESP32-C6 / TX-AH module mapping
- **Rule:** This is a RISC-V architecture utilizing the ESP-IDF v5.3+ toolchain. Standard Xtensa assembly or legacy ESP32-WROOM libraries are strictly invalid. Code must utilize native MIPI-CSI peripheral drivers for video capture streams.

## Infrastructure: Heltec HT-H7608 (HaLow Gateway / Router)
- **Role:** Standalone Wi-Fi HaLow (802.11ah) gateway/router — the base station our HC33/HC01 nodes associate to. Dual-band: HaLow sub-1 GHz + 2.4 GHz, with RJ45 Ethernet for the wired uplink.
- **Not flashable by us:** This is a finished product configured through its **web admin page**, not custom firmware. Do NOT write/build `.ino` code for it.
- **LAN-side config:** Default page at `10.42.0.1` (login `root` / `heltec.org` — change it). Reach it by wired Ethernet, or over its 2.4 GHz AP (`HT-HXXX-xxxx-2G`, pass `heltec.org`). Once it has a LAN IP, browse to that IP or `192.168.100.1` over the AP.
- **Gateway (AP) setup:** Set upstream network = **Ethernet/RJ45**, enable **Gateway (AP) mode**, set HaLow SSID/PSK, use the **US 915 MHz** band to match our nodes, ~4 MHz bandwidth.
- **Lights:** red = booting (~1–2 min) → blinking yellow/green = ready to configure → steady green/blue = upstream connected and running.
- **Scope:** Serves the **HC33/HC01** HaLow network. This is a *separate* gateway from the LilyGO T-HaLow Ethernet bridge (see [`docs/lilygo t-halow-gateway-spec.md`](../../docs/lilygo%20t-halow-gateway-spec.md)), which serves the P4 nodes.
- **Docs:** [usage guide](https://wiki.heltec.org/docs/devices/wifi-halow/ht-h7608/usage-guide) · [Gateway (AP) mode](https://docs.heltec.org/en/wifi_halow/halow_guide/gateway.html) · [product page](https://heltec.org/project/ht-h7608/)