# HaLow Uplink on the HT-HC33 (design + Decision Record)

**In plain words:** the deployed cameras are too far from any router for
normal Wi-Fi, so they use **HaLow** — a slower radio that reaches much
farther (sub-GHz, think "walkie-talkie range but for internet"). This doc
records how the HaLow link was wired into the HT-HC33 fleet firmware
(`cloud_telemetry_node/`) and *why* it's shaped the way it is. The plain
2.4 GHz Wi-Fi path stays fully working for bench/dev use.

Related: [`cloud_telemetry_node/README.md`](../cloud_telemetry_node/README.md)
(user-facing setup), [`.agents/rules/EXTERNAL_CONTEXT.md`](../.agents/rules/EXTERNAL_CONTEXT.md)
(authoritative vendor sources).

## How it fits together

```
cloud_telemetry_node.ino          "am I online?"
        │
        ▼
net_link.{h,cpp}    netConnect(): halow | wifi | both ("both" = HaLow first,
        │                         fall back to 2.4 GHz)
        ▼
net_http.{h,cpp}    NetHttp: one HTTP wrapper that forwards each request to
        │           HTTPClient (2.4 GHz) or HalowHTTPClient (HaLow)
        ▼
cloud_backend.cpp / ota_update.cpp   status, commands, photo upload, OTA
```

Credentials and `netMode` were already provisioned into NVS before this
landed (`device_config.{h,cpp}`), so no dashboard or provisioning changes
were needed — stored HaLow creds simply became live.

## Decision Record (append-only; mark superseded sections, don't delete)

### 2026-07-17 — Wrap HTTP in `NetHttp` instead of unifying the client stacks

The Heltec `heltec:esp_halow` core ships HaLow support as a **parallel copy**
of the networking classes (`HalowClient`, `HalowClientSecure`,
`HalowHTTPClient` in `libraries/wifi-halow`), not as a second interface
behind the standard `WiFiClient`/`HTTPClient`. `HTTPClient::begin()` only
accepts a `WiFiClient&`, and `HalowClient` is not one — so a single client
stack can't serve both radios.

- **Chosen:** a thin `NetHttp` wrapper (`net_http.{h,cpp}`) holding one
  instance of each stack and forwarding the ~12 methods the firmware actually
  uses to whichever radio `netActiveLink()` reports. Call sites keep the
  exact `begin / addHeader / POST / end` shape they had.
- **Rejected: patching the vendor core** so `HTTPClient` accepts both — we'd
  be maintaining a fork of the board package, and every student install of
  the stock core would silently build something different.
- **Rejected: NAPT/bridge modes** (the core's `NAPT_HalowSTA_*` examples) —
  those are for a *gateway* device that shares a HaLow link with other Wi-Fi
  clients; a battery camera doesn't want a second radio up just for routing.
- The two vendor APIs are mirror copies (same signatures, per
  `HelTecAutomation/ESP_HaLow` @ `libraries/wifi-halow/src`), so the wrapper
  is mechanical. If the fleet firmware needs an HTTP feature `NetHttp`
  doesn't expose yet, add the forwarding method rather than reaching around
  the wrapper.

### 2026-07-17 — "both" = HaLow first, then 2.4 GHz

Order matters for the field case: production cameras are in HaLow range but
usually NOT in 2.4 GHz range, so HaLow-first means one association attempt on
a normal wake. The fallback keeps a bench board (no HaLow gateway) working
with zero config changes. This encodes the semantics `device_config.h`
documented back when HaLow creds were provision-only.

### 2026-07-17 — Vendor API usage (per `HelTecAutomation/ESP_HaLow` examples)

From `UDP_Client_lowpower` and `BasicHttpsClient`: `HaLow.init(region)` once,
`HaLow.begin(ssid, passphrase)` (SAE security is the library default — HaLow
networks use WPA3's password scheme), then poll `HaLow.status()` until
`WL_CONNECTED`. We additionally wait for a non-zero `HaLow.localIP()` so the
first HTTP call never races DHCP. The `HALOW_LDO_CTRL` power-pin dance in the
examples is `HT_RC3268`-only; the HT-HC33 variant needs none of it (its
module pins are wired in the core's `variants/HT-HC33/pins_arduino.h`).

### 2026-07-17 — Separate OTA RSSI floor for HaLow (-90 dBm vs -75 dBm)

The OTA safety gate refuses to flash over a link weaker than -75 dBm — tuned
for 2.4 GHz, where that's the edge of usable. Sub-GHz HaLow is routinely
healthy well below that (long range is its whole point), so the same floor
would wrongly veto OTA on good field links. -90 dBm is conservative for
HaLow's low-rate modes. Constant lives in `ota_update.cpp`
(`HALOW_RSSI_FLOOR_DBM`), mirrored in the `HT-HC33_OTA_Unit` bench sketch per
its SYNC RULE.

### 2026-07-17 — Wi-Fi credential trial is judged by the Wi-Fi radio only

The dashboard's `set_wifi` command starts a trial: new 2.4 GHz creds must
connect within N wakes or the board reverts to the old ones. "We're online"
stopped being a valid verdict once HaLow could be the radio that got us
online — a bad Wi-Fi password would get committed because HaLow connected.
`netWifiAttempt()` reports what the 2.4 GHz radio itself did
(skipped / failed / connected); the trial only advances on a wake where Wi-Fi
was actually tried. In `"both"` mode with a healthy HaLow link the trial can
stay pending for a while — accepted, since the camera is online the whole
time.

### 2026-07-17 — No HaLow power-down before deep sleep (for now)

`netShutdown()` turns the 2.4 GHz radio off before deep sleep, as before. The
vendor library exposes no HaLow stop API (the module resets with the chip on
deep-sleep wake). If field battery numbers show the HT-HC01 drawing
meaningful sleep current, revisit — candidate: hold `CONFIG_MM_RESET_N` low
via RTC GPIO hold. Measure first; see `docs/POWER_SYSTEM.md`.

## What was verified, honestly

- All vendor class/method signatures were checked against a fresh clone of
  `HelTecAutomation/ESP_HaLow` (the same tree the Arduino core installs).
- **Not yet compiled or radio-tested**: this environment can't fetch the
  Xtensa toolchain, so the change is pending an Arduino IDE build
  (`heltec:esp_halow:HT-HC33`) and a live wake cycle against a HaLow gateway.
  First bench check: provision `net_mode both` + real `halow_ssid`/`halow_psk`,
  watch serial for `[halow] connected, IP …` then `report SENT ✓`.
