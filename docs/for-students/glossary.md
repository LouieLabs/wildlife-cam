# Plain-English Glossary

Techy terms you'll hear on this project, each translated into something familiar.
You do **not** need to memorize these — just look them up when one shows up.

## The board & chips

- **Microcontroller / MCU / ESP32** — the tiny computer brain on the board. Like
  a phone's processor, but much smaller and simpler.
- **GPIO pin** — one of the little metal connection points on the board. Each is
  a "wire" the brain uses to talk to a part (camera, card, LED). "GPIO 15" just
  means "wire number 15."
- **PSRAM / Flash** — the board's memory. *Flash* = where the instructions live
  (like a phone's storage). *PSRAM* = scratch space for working (like RAM).
- **Firmware** — the program loaded onto the board. "Software that lives inside a
  device."

## Talking to parts

- **SPI / I2C** — two ways the brain passes messages to a part over a few wires.
  Think "two different languages for passing notes." The memory card uses SPI.
- **Serial / Serial Monitor / baud / 115200** — a text channel where the board
  prints messages to your computer over USB. *Baud* = how fast it talks; both
  sides must agree (we use 115200). The *Serial Monitor* is the window that shows
  those messages.
- **UART / CP2102** — the little translator chip that carries those text messages
  over the USB cable.

## Saving photos on the board

- **Internal flash** — the board's own built-in storage chip (16 MB). Holds the
  firmware *and* (in fleet mode) the photos before they upload. Doesn't fall out
  like a memory card.
- **LittleFS** — the way we organize files on internal flash. Think of it as the
  filesystem on a tiny solid-state drive — a "file" called `wildcam_42.jpg` is
  really a few KB of bits in flash that LittleFS knows how to find again.
- **NVS (non-volatile storage)** — a separate, tiny area of flash for *settings*
  (Wi-Fi name, the board's identity, its 10-char secret). Survives power loss
  *and* reflashing the firmware, so you only have to set it up once per board.
- **Provisioning** — the one-time step of writing the Wi-Fi + identity into NVS
  via the dashboard's "Set up a camera" page (or via `secrets.h` for bench
  work). The board can't reach the cloud until this is done.
- **Partition table** — the floor plan of internal flash: "this slice is for
  firmware, this slice is for OTA updates, this slice is for photos." Changing
  the floor plan after photos are saved would wipe them, which is why we set
  the layout up front. See [`docs/FLASH_STORAGE_OTA_PLAN.md`](../FLASH_STORAGE_OTA_PLAN.md).
- **OTA (over-the-air) update** — pushing new firmware to a deployed camera
  wirelessly, no USB cable. Not built yet; the partition layout reserves space
  for it.

## The memory card (legacy — we don't use these anymore)

Kept here because the [sd-card-story](sd-card-story.md) and old code mention
them. Fleet-mode cameras now use internal flash (above) instead.

- **SD / microSD card** — a removable "photo album" storage card.
- **Format / FAT32 / exFAT** — how the card was organized so a device could read
  it. The board needed the **FAT32** style.
- **MBR (Master Boot Record)** — the very first "label" on the card that said
  how it was divided up. The board only understood **MBR** (not the newer
  "GUID" style a Mac uses by default).
- **Mount** — when the board successfully "opened" the card and could read/write
  it. "Mount failed" was the usual error when a card was acting up.

## Wireless

- **Wi-Fi HaLow** — a long-range version of Wi-Fi (reaches much farther than
  normal Wi-Fi, but slower). Good for a camera out in a field.
- **OV3660 / MIPI-CSI** — the camera sensor and the fast wire it uses to send
  pictures to the brain.

## Fleet mode (cloud dashboard)

- **Deep sleep** — when the board powers down everything except a tiny timer to
  save battery. It wakes up on a schedule (or a sensor), does its job, and goes
  back down. Like a phone in airplane-mode-with-a-wake-alarm.
- **Web Serial** — a way for a web page (in Chrome or Edge on a desktop) to talk
  to a device plugged into your USB port. The "Set up a camera" page uses this
  to write Wi-Fi + identity to the board. Doesn't work on Safari or phones.
- **Dashboard / web app** — the website at `web/` where you see all your
  cameras, their battery, and the photos they uploaded.
- **Device secret** — a 10-character password (`XXX-XXX-XXXX`) that proves a
  photo or status report really came from *that* camera, not somewhere else.
  Each board has its own; leaking one only burns that one camera.

## Saving & sharing code (Git)

- **Repo (repository)** — the shared online folder that holds all the project's
  files and their history.
- **Commit** — a saved snapshot of your changes, with a note describing them.
- **Push** — uploading your commits to the shared repo so others get them.
- **Branch** — a separate copy of the project to try things without breaking the
  main version.
- **Pull request (PR)** — asking to merge your branch's changes into the main
  version, so others can review first.
- **Token** — your personal password-key for the repo. **Never share yours** —
  each person uses their own.

## Tools

- **Arduino IDE** — the app where you write firmware and upload it to the board.
- **PlatformIO** — a different (more advanced) way to build firmware. We tried it
  and **parked it** — it doesn't fully support our board yet.
- **Flash / Upload** — sending your firmware onto the board (like installing an
  app onto a phone).
- **Reset (RST) vs. Power-cycle** — *Reset* restarts the brain but keeps parts
  powered. *Power-cycle* = fully unplug the USB for a few seconds (cuts power to
  everything). Some "stuck" problems only clear with a full power-cycle, like
  restarting a frozen phone instead of just locking/unlocking it.
