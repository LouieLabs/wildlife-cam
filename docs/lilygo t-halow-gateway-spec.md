# Design Spec: LilyGO T-HaLow (ESP32-S3) — HaLow-to-Ethernet Gateway Bridge

**Project:** CritterWatch / Louie Labs  
**Purpose:** Turn one LilyGO T-HaLow (ESP32-S3) into a dedicated HaLow Access Point + Ethernet bridge so that LilyGO T-HaLow P4 camera nodes (Taixin TX-AH chip) can reach the internet via a wired LAN connection, operating in parallel with the existing Heltec HT-H7608 gateway used by HC33 nodes.

---

## 1. Hardware

### 1.1 Primary Board
- **LilyGO T-HaLow V2** (ESP32-S3, 16 MB Flash, 8 MB PSRAM)
- Onboard **TX-AH (Taixin TXW8301)** HaLow module
- ESP32-S3 communicates with TX-AH via **UART** (AT commands) in Mode 1
- Board runs on **PlatformIO + Arduino framework** (same toolchain as T-HaLow examples repo)

### 1.2 Ethernet Module (external, wired to GPIO header)
- **WIZnet W5500** SPI Ethernet module (hardwired TCP/IP, 100 Mbps)
- Connects to ESP32-S3 via SPI on the 2×16-pin GPIO expansion header
- Suggested pin assignments (adjust if schematic conflict found):

| Signal     | ESP32-S3 GPIO |
|------------|---------------|
| W5500 SCK  | GPIO 36       |
| W5500 MISO | GPIO 37       |
| W5500 MOSI | GPIO 38       |
| W5500 CS   | GPIO 39       |
| W5500 RST  | GPIO 40       |
| W5500 INT  | GPIO 41       |

> **Implementer note:** Verify these GPIOs against the T-HaLow V2 schematic (`hardware/` in the repo) to confirm none are used by the TX-AH UART, SD card, or TF card. Reassign as needed and document final pin mapping at the top of the source file.

### 1.3 TX-AH UART Pins (fixed by board hardware)
The TX-AH module is hardwired to the ESP32-S3 on the T-HaLow V2. From the LilyGO examples:
- TX-AH RX ← ESP32-S3 TX (check `examples/AP/` or `examples/STA/` in repo for exact GPIO)
- TX-AH TX → ESP32-S3 RX
- Document these in the config header.

---

## 2. Functional Overview

This firmware makes the T-HaLow board act as a **HaLow AP + Ethernet bridge**:

```
[T-HaLow P4 camera nodes]
        |
   HaLow 802.11ah (TX-AH, Taixin proprietary)
        |
[T-HaLow ESP32-S3 — THIS DEVICE]
   TX-AH in AP mode (HaLow side)
   ESP32-S3 bridges packets: HaLow ↔ Ethernet
   W5500 → Ethernet cable → home router / switch
        |
   [Internet / GCS Cloud Upload]
```

The ESP32-S3 is the bridge CPU. It does NOT run a TCP/IP stack for the camera nodes — it forwards raw Ethernet frames between the HaLow side (AT+TXDATA / serial RX) and the W5500 Ethernet side.

---

## 3. Firmware Architecture

### 3.1 Startup Sequence

1. Initialize Serial (USB CDC, 115200 baud) for debug logging.
2. Initialize `Serial1` (or `Serial2`) for TX-AH AT command UART at **921600 baud** (match TX-AH firmware default).
3. Initialize W5500 over SPI. Assign a static MAC. Obtain IP via DHCP from the home router.
4. Configure TX-AH as AP:
   - `AT+MODE=AP`
   - `AT+SSID=<HALOW_SSID>` (configurable constant, e.g. `"critterwatch-halow"`)
   - `AT+KEYMGMT=WPA-PSK`
   - `AT+PSK=<64-hex-char-psk>` (configurable constant)
   - `AT+BSS_BW=4` (4 MHz channel for good throughput/range balance)
   - `AT+CHAN_LIST=9150` (915 MHz center, US 915 MHz variant)
   - `AT+HEART_INT=1000`
   - `AT+PAIR=0` (no pairing mode; STAs connect by SSID/PSK)
5. Log "Gateway ready" on Serial.

### 3.2 Main Loop — Packet Bridging

The ESP32-S3 bridges Layer 2 Ethernet frames bidirectionally:

**HaLow → Ethernet (uplink):**
- Poll `Serial1` (TX-AH UART) for incoming data frames.
- TX-AH delivers raw Ethernet frames prefixed by a length field (per AT+TXDATA protocol: 14-byte Ethernet header + payload).
- Parse the incoming frame. Forward it verbatim to W5500 via `Ethernet.sendPacket()` (raw socket).

**Ethernet → HaLow (downlink):**
- Poll W5500 for incoming raw Ethernet frames addressed to a connected STA MAC or broadcast.
- Send via `AT+TXDATA=<length>` followed by the raw frame bytes on Serial1.

### 3.3 AT Command Helper

Write a small blocking AT command helper function:
```
bool sendAT(const char* cmd, const char* expectedResponse, uint32_t timeoutMs);
```
- Writes `cmd + "\r\n"` to Serial1.
- Waits up to `timeoutMs` for `expectedResponse` in the response.
- Returns true on match, false on timeout.
- On startup failure, log error and retry up to 3 times before halting with an LED error blink.

### 3.4 Frame Parsing from TX-AH UART

The TX-AH in AP mode delivers received frames on the UART. The frame format from Taixin firmware is:
- A length prefix indicating total frame bytes
- Followed by a raw 802.3 Ethernet frame (14-byte header + payload)

**Implementer note:** Consult `examples/AP/` or `examples/STA/` in the T-HaLow repo for the exact UART receive framing (prefix bytes, delimiters). Match that exactly. If the examples use a specific ring buffer or stream parser, replicate that pattern.

---

## 4. Configuration (top of source file, easy to edit)

```cpp
// === HaLow AP Config ===
#define HALOW_SSID       "critterwatch-halow"
#define HALOW_PSK        "aabbcc..."          // 64 hex chars
#define HALOW_BSS_BW     4                    // MHz: 1, 2, 4, or 8
#define HALOW_CHAN_LIST  "9150"               // 915 MHz center (US)

// === W5500 SPI Pins ===
#define ETH_SCK   36
#define ETH_MISO  37
#define ETH_MOSI  38
#define ETH_CS    39
#define ETH_RST   40
#define ETH_INT   41

// === W5500 Network ===
// Static MAC for W5500 (must be unique on LAN)
static uint8_t ETH_MAC[] = { 0x02, 0xAB, 0xCD, 0xEF, 0x01, 0x02 };
// Set USE_DHCP=true; if DHCP fails, fall back to static:
#define USE_DHCP         true
#define STATIC_IP        { 192, 168, 1, 200 }
#define STATIC_GATEWAY   { 192, 168, 1, 1 }
#define STATIC_SUBNET    { 255, 255, 255, 0 }

// === TX-AH UART ===
#define TXAH_UART_BAUD   921600
// Fill these in after checking schematic:
#define TXAH_TX_GPIO     XX   // ESP32-S3 TX → TX-AH RX
#define TXAH_RX_GPIO     YY   // ESP32-S3 RX ← TX-AH TX

// === Debug ===
#define DEBUG_SERIAL     Serial
#define DEBUG_BAUD       115200
```

---

## 5. Libraries

| Library | Purpose |
|---|---|
| `Ethernet` (Arduino built-in or `Ethernet` by Various) | W5500 driver |
| `SPI` (Arduino built-in) | SPI bus for W5500 |
| `HardwareSerial` (ESP32 Arduino core) | UART to TX-AH |

No exotic libraries required. Use the standard Ethernet library's raw socket / `EthernetUDP` for low-level frame access, or use `ETH` from the ESP32 Arduino core if it supports W5500 in raw mode.

**Preferred:** Use Espressif's `esp_eth` + W5500 SPI driver via ESP-IDF component if the project is built with ESP-IDF; otherwise use the Arduino `Ethernet.h` W5500 raw socket approach.

---

## 6. PlatformIO Configuration

```ini
[env:t-halow-gateway]
platform = espressif32
board = esp32s3box
framework = arduino
monitor_speed = 115200
upload_speed = 921600
build_flags =
    -DARDUINO_USB_CDC_ON_BOOT=1
board_build.partitions = default_16MB.csv
board_build.flash_size = 16MB
board_upload.flash_size = 16MB

lib_deps =
    Ethernet
```

Arduino IDE settings (if not using PlatformIO):
- Board: ESP32S3 Dev Module
- Flash Size: 16MB (128Mb)
- Partition Scheme: 16M Flash (3M APP/9.9MB FATFS)
- PSRAM: OPI PSRAM
- USB CDC On Boot: Enabled
- Upload Mode: UART0/Hardware CDC

---

## 7. Error Handling

- If W5500 hardware not found on SPI: log error, blink LED fast (10 Hz), halt.
- If DHCP fails after 10 s: fall back to static IP, log warning, continue.
- If TX-AH AT init fails after 3 retries: log error, blink LED slow (1 Hz), halt.
- If TX-AH UART goes silent for >30 s during operation: attempt re-init sequence, log event.
- All errors printed to `DEBUG_SERIAL`.

---

## 8. What This Does NOT Do

- Does **not** run NAT or DHCP server — the home router handles that; the bridge is Layer 2.
- Does **not** implement IP routing — pure Ethernet frame forwarding.
- Does **not** support the HT-H7608 gateway or Heltec HC01 nodes — those run on a completely separate HaLow network via the HT-H7608.
- Does **not** use the ESP32-S3's built-in 2.4 GHz WiFi — left disabled to avoid interference and reduce power.

---

## 9. Validation Steps (for the implementer to test)

1. Flash firmware. Confirm "Gateway ready" on Serial.
2. Flash a second T-HaLow (ESP32-S3) with the existing LilyGO STA example. Confirm it associates to the AP SSID.
3. From the STA, ping the gateway's Ethernet IP. Confirm packet traversal.
4. Flash the T-HaLow P4 STA firmware. Confirm it associates and can reach the internet (ping 8.8.8.8 via the cloud).
5. Run a sustained upload test (simulate camera frame upload) and confirm no frame loss over 60 seconds.

---

## 10. Key References

- T-HaLow repo: `https://github.com/Xinyuan-LilyGO/T-Halow`
- AT command reference: `docs/AT_cmd.md` in that repo
- TX-AH frame format / UART protocol: `examples/AP/` and `examples/STA/` in that repo
- T-HaLow V2 schematic: `hardware/` directory in that repo (verify GPIO assignments before coding)
- W5500 Arduino library: `https://github.com/WIZnet/WIZnet-ArduinoEthernet` or standard `Ethernet.h`
