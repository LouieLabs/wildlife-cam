# Fleet-Mode Setup (cloud dashboard camera)

This guide gets you from "I have a Heltec board" to "my camera shows up on the
LouieLabs dashboard and is napping correctly." If you want a single camera that
streams live video to your browser instead, skip this and use the top-level
[`README.md`](../../README.md) Setup section.

> **In plain words.** You're going to: (1) tell the website "I have a new
> camera" so it gives you a secret password, (2) load the firmware onto the
> board with a USB cable, (3) hand the board its Wi-Fi name + secret over USB
> via a webpage that does it for you, then (4) watch the dashboard light up
> green. About 10 minutes once you have the bits in place.

## Before you start — checklist

You need:

- A **Heltec HT-HC33** board (the small green/black one with the camera lens)
- A **USB-C cable** that does **data + power** (a charge-only cable looks the
  same and won't work — if your Mac doesn't see the board, try a different
  cable first)
- A **desktop computer running Chrome or Edge**. The provisioning page uses a
  feature called *Web Serial* that only works on Chrome/Edge desktop — **not
  Safari, not Firefox, not phones, not iPads**.
- The **Arduino IDE** installed, with the **Heltec ESP32 HaLow** core added (if
  you've flashed any HT-HC33 sketch before, you've got it)
- A **`@louielabs.com` Google account** for the dashboard
- The **Wi-Fi name + password** of the network the camera will be on (must be
  **2.4 GHz** — the board can't see 5 GHz networks)

## Step 1 — Register the camera on the dashboard

> **In plain words.** Tell the website "a new camera is coming" so it can give
> it a name and a secret password. Without this, the dashboard won't recognize
> the board when it phones home.

1. Open the dashboard — the URL is in [`web/README.md`](../../web/README.md)
   under "Deployed at" (it's a long Cloud Run URL; ask a teammate if you can't
   find it).
2. Sign in with your `@louielabs.com` Google account.
3. Go to **Set up a camera** (or open `/provision` on the dashboard URL).
4. Give the camera an ID — something short and memorable like `cam-yard-01`.
   This is what you'll see in the dashboard list.

Leave that browser tab open — you'll use it again in Step 3.

## Step 2 — Flash the firmware

> **In plain words.** Load the program onto the board over USB. This is the
> same as installing an app on a phone — once it's on, it stays on until you
> overwrite it.

1. Plug the board into your computer with the USB-C cable.
2. Open **Arduino IDE** → File → Open → pick the
   [`cloud_telemetry_node/cloud_telemetry_node.ino`](../../cloud_telemetry_node/cloud_telemetry_node.ino)
   sketch.
3. Tools menu:
   - **Board** → Heltec ESP32 HaLow → **HT-HC33**
   - **Upload Speed** → **460800** (⚠️ not 921600 — it corrupts the upload)
   - **Port** → whichever `/dev/cu.usbserial-*` or `COM*` appeared when you
     plugged the board in
4. Click **Upload** (the right-arrow button). Wait ~30 s. You should see
   `Hash of data verified` and the board's LED flickers.
5. **Don't open Serial Monitor yet.** The provisioning page in the next step
   needs the serial port to itself.

## Step 3 — Provision it over USB

> **In plain words.** The board boots up not knowing your Wi-Fi or who it is.
> A webpage pushes that info into the board's permanent storage over the USB
> cable — once written, it stays even if you reflash later.

1. Go back to the dashboard tab from Step 1, on the **Set up a camera** page.
2. **Unplug and re-plug** the board's USB cable (or press its **RST** button)
   — this gives the page a fresh 10-second window to catch the board.
3. On the webpage, click **Connect**. A picker opens — choose the same serial
   port you used in Arduino IDE.
4. Enter your **Wi-Fi name + password** (2.4 GHz network), and confirm the
   camera ID from Step 1.
5. Click **Provision** (or **Save**). The page resets the board, reads its
   identity, mints a 10-character secret (`XXX-XXX-XXXX`), and writes
   everything to the board's NVS (its permanent settings storage). ~10 s.

When it's done the page will say so. You can close it.

## Step 4 — Verify it shows up

> **In plain words.** Watch the dashboard. If everything's wired up right, the
> camera should appear with a green dot within ~30 seconds.

1. Open **Serial Monitor** in Arduino IDE at **115200 baud**.
2. You should see something like:
   ```
   wake #1 … connecting WiFi … report SENT ✓ … sleeping 30s
   ```
3. On the dashboard, your camera should turn **🟢 online** with a battery
   reading. From here on, every ~30 seconds it'll wake, report in, and sleep.

That's it — the camera is provisioned and operational. You can unplug it from
USB and power it from a battery; it'll keep checking in as long as it has
Wi-Fi reach.

## What it does from here

- **Naps and wakes.** Every `SLEEP_SECONDS` (default 30s — see
  `cloud_telemetry_node/node_config.h`), the board wakes, reports its status,
  checks for a command (like "take a picture"), uploads any pending photo,
  and goes back to sleep.
- **Photos live on the board.** When you press **Take Picture** on the
  dashboard, the photo is saved to the board's internal flash, then uploaded
  the next time it wakes up. If the upload fails, the photo stays on flash
  and tries again next wake — so a Wi-Fi blip doesn't lose photos.
- **No more `secrets.h` editing.** Wi-Fi + identity live in NVS (permanent
  settings) now. If you reflash the firmware to update code, those settings
  survive — you don't have to provision again.

## Common issues

| Symptom | What to try |
|---|---|
| Provisioning page can't see the board | Wrong cable (charge-only) or wrong port. Try a different USB-C cable; check the Tools → Port list in Arduino IDE. |
| Provisioning page picker shows no ports | You're on Safari/Firefox/mobile. Switch to **Chrome or Edge on a desktop**. |
| Board never goes online (no 🟢) | Wrong Wi-Fi password, or the network is 5 GHz (the board can't see it). Re-provision with a 2.4 GHz network. |
| Board "stuck" — no serial output, won't reflash | Unplug USB for **5 full seconds**, then re-plug. A reset button isn't always enough. |
| Upload fails with checksum errors | Upload Speed is too high. Set it to **460800** (not 921600). |
| Provisioned but nothing on the dashboard | Confirm the camera ID on the dashboard matches what you provisioned. Refresh the dashboard. |

## If you can't use Chrome/Edge desktop

If you're stuck on Safari, an iPad, or somewhere without Web Serial, there's a
fallback that uses `secrets.h` editing instead — see
[`cloud_telemetry_node/README.md`](../../cloud_telemetry_node/README.md),
section **Path B**. The dashboard path is recommended; the fallback exists for
bench work and edge cases.

## Want to understand what just happened?

- **[glossary.md](glossary.md)** — definitions for *NVS*, *provisioning*,
  *LittleFS*, *deep sleep*, *Web Serial*, *device secret*, and friends
- **[../FLASH_STORAGE_OTA_PLAN.md](../FLASH_STORAGE_OTA_PLAN.md)** — why
  photos live on internal flash instead of a microSD card (and how the OTA
  update slots work)
- **[../../cloud_telemetry_node/README.md](../../cloud_telemetry_node/README.md)**
  — the full technical reference for the firmware
