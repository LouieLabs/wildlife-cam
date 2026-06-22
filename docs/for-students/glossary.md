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

## The memory card

- **SD / microSD card** — the removable "photo album" storage.
- **Format / FAT32 / exFAT** — how the card is organized so a device can read it.
  Like the card's "table of contents." This board needs the **FAT32** style.
- **MBR (Master Boot Record)** — the very first "label" on the card that says how
  it's divided up. This board only understands the **MBR** style of label (not the
  newer "GUID" style a Mac uses by default).
- **Mount** — when the board successfully "opens" the card and can read/write it.

## Wireless

- **Wi-Fi HaLow** — a long-range version of Wi-Fi (reaches much farther than
  normal Wi-Fi, but slower). Good for a camera out in a field.
- **OV3660 / MIPI-CSI** — the camera sensor and the fast wire it uses to send
  pictures to the brain.

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
