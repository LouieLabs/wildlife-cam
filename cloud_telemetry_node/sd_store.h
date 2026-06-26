#pragma once
#include <Arduino.h>
#include "halow_SD.h"   // Heltec core library -> gives the SD object + FS.h (File)

// microSD storage for captured photos. Uses the HT-HC33's dedicated HSPI bus
// (same pins as the live-stream sketch). We save first, upload later, so a
// photo is never lost if the (slow) HaLow upload fails or is interrupted.

// Mount the card and make sure /wildcam exists. Returns true on success.
bool sdInit();

// Save a JPEG to /wildcam. Uses an epoch-ms name when the clock is real,
// otherwise a sequence number. Returns the file path, or "" on failure.
String sdSaveJpeg(const uint8_t *data, size_t len, long long tsMs, uint32_t seq);

// Open a saved file for reading (caller closes it).
File sdOpen(const String &path);
