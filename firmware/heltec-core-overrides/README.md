# Heltec core overrides — 16MB flash + OTA-ready partition layout (HT-HC33)

## In plain words

The wildlife camera's memory chip is really **16 MB**, but the factory Heltec
setup only used **8 MB** of it. These files unlock the full chip and carve it
into a fixed floor plan: two 2 MB rooms for software (so we can update the
camera over Wi-Fi later — "OTA") and one big ~11.9 MB room for photos.

**The one rule:** once this layout is flashed to a board, never change the
floor plan again. Re-drawing it would move the photo room and erase any photos
already stored on the device. The OTA software rooms are reserved up front for
exactly this reason — so future updates never need to repartition.

## What's here → where it goes in the core

`<core>` = the manually-installed Heltec core, currently
`/Users/alan/Documents/Arduino/hardware/heltec/esp_halow`.

| Repo file | Copy to | Job |
|-----------|---------|-----|
| `boards.local.txt` | `<core>/boards.local.txt` | sets flash **size** to 16 MB + 2 MB sketch guard |
| `variants/HT-HC33/partitions.csv` | `<core>/variants/HT-HC33/partitions.csv` | the floor plan (**this is what's enforced**) |
| `factory-originals/HT-HC33-variant-partitions.csv.orig` | (reference only) | the 8 MB table we replaced |

## Why it takes two files (and why the variant file, not a menu)

- **Flash size** is baked into the firmware image when it's built. If the size
  label says 8 MB, the chip physically can't reach its top half — and the photo
  room lives up there. `boards.local.txt` sets it to 16 MB.
- **The floor plan** can't be set by a normal "Partition Scheme" menu here,
  because the Heltec core copies `variants/HT-HC33/partitions.csv` into *every*
  build and that file outranks any menu/`build.partitions` setting. So the only
  way to truly force our layout is to **replace that variant file** — which we
  do. Bonus: this automatically applies to every HT-HC33 sketch, no dropdown to
  get wrong (this is the "force mode" decision).

## Install / re-apply (after a manual core reinstall)

A manual reinstall wipes `boards.local.txt` **and** restores the factory 8 MB
variant table, so re-copy **both** files:

```sh
CORE=/Users/alan/Documents/Arduino/hardware/heltec/esp_halow
cp boards.local.txt                "$CORE"/boards.local.txt
cp variants/HT-HC33/partitions.csv "$CORE"/variants/HT-HC33/partitions.csv
```

Then fully quit and reopen the Arduino IDE so it re-reads the board config.

## The floor plan (locked)

Total flash: 16 MB (`0x1000000`).

| Room | Purpose | Offset | Size |
|------|---------|--------|------|
| nvs | small settings store | `0x9000` | 20 KB |
| otadata | tracks which app slot is active | `0xe000` | 8 KB |
| app0 | firmware slot A | `0x10000` | 2.0 MB |
| app1 | firmware slot B (OTA spare) | `0x210000` | 2.0 MB |
| spiffs | **photo storage (LittleFS)** | `0x410000` | ~11.9 MB |
| coredump | crash logs | `0xFF0000` | 64 KB |

The storage partition keeps the label `spiffs` on purpose: the Arduino
`LittleFS` library mounts that partition by default, so `LittleFS.begin()`
works with no extra arguments even though the filesystem is LittleFS, not SPIFFS.

## How to verify (already confirmed once via arduino-cli)

1. A compile reports max sketch size **2097152** bytes (2 MB) — done ✔
2. The table copied into the build matches `variants/HT-HC33/partitions.csv` — done ✔
3. On-device (next step, needs the real sketch): `LittleFS.begin(true)` then
   `LittleFS.totalBytes()` should report **≈ 11.5 MB**.
