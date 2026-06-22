# Antigravity Context Anchor: Authorized Manufacturer References

Whenever the user prompts for embedded firmware changes, camera configuration routines, or sub-GHz network tasks involving our deployment hardware, you MUST consult these authorized live repository targets to cross-reference current implementation paradigms, AT command lists, and pin registers. 

Do not hallucinate standard Arduino WiFi methods; use the explicit vendor implementations found at these live paths:

## 1. Heltec HT-HC33 (ESP32-S3 Wi-Fi HaLow Framework)
* **Primary Framework Repository:** `https://github.com/HelTecAutomation/ESP_HaLow`
* **Syntax Guardrail:** Focus on the low-power UDP client examples (`UDP_Client_lowpower`) and video handling scripts inside this tree. Ensure I2C configurations for the OV3660 match factory driver assignments.

## 2. Lilygo T-Halow-P4 (RISC-V Video Processing Node)
* **Primary Documentation Repository:** `https://github.com/Xinyuan-LilyGO/T-Halow`
* **Syntax Guardrail:** Consult the documentation paths (`/docs/AT_cmd.md` and `/docs/ver2/readme.md`). All configuration logic must explicitly structure serial execution to communicate with the onboard TX-AH sub-GHz companion module via the documented AT commands (e.g., `AT+MODE`, `AT+PAIR`).