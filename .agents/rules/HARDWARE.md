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