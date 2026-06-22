# Antigravity Context Anchor: Authorized Manufacturer References

These are the authoritative vendor sources for our deployment hardware. **Consult
them only when you actually need vendor-specific detail** — i.e. when you are
uncertain, or when the task depends on HaLow radio APIs, AT commands, camera/I2C
register assignments, or exact pin mappings. **Do not fetch them for every firmware
prompt:** skip the lookup for routine code (GPIO toggling, SD/file I/O, general
Arduino logic) where you are already confident.

When you do rely on a vendor-specific behavior, prefer these explicit
implementations over guessed or generic Arduino WiFi methods, and cite the source
you used:

## 1. Heltec HT-HC33 (ESP32-S3 Wi-Fi HaLow Framework)
* **Primary Framework Repository:** `https://github.com/HelTecAutomation/ESP_HaLow`
* **Syntax Guardrail:** Focus on the low-power UDP client examples (`UDP_Client_lowpower`) and video handling scripts inside this tree. Ensure I2C configurations for the OV3660 match factory driver assignments.

## 2. Lilygo T-Halow-P4 (RISC-V Video Processing Node)
* **Primary Documentation Repository:** `https://github.com/Xinyuan-LilyGO/T-Halow`
* **Syntax Guardrail:** Consult the documentation paths (`/docs/AT_cmd.md` and `/docs/ver2/readme.md`). All configuration logic must explicitly structure serial execution to communicate with the onboard TX-AH sub-GHz companion module via the documented AT commands (e.g., `AT+MODE`, `AT+PAIR`).