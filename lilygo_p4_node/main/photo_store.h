#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// LittleFS photo queue -- P4 port of the HT-HC33 flash_store. Same safety
// contract: save first, upload later, delete ONLY after the backend confirms
// the upload, so a network blip never loses a photo.
//
// Filenames embed the wake reason + capture time so a photo uploaded on a
// later wake still gets a descriptive cloud name:
//   /wildcam/<REASON>_<epochMs>.jpg   or   /wildcam/<REASON>_seq<N>.jpg

#define PHOTO_PATH_MAX 96

// Mount LittleFS (formats on first boot) and ensure /wildcam exists.
bool photo_store_init(void);

// Save a JPEG. reason: "PIR"/"BUTTON"/"TIMER"/"COLDBOOT". ts_ms 0 = clock not
// synced -> sequence-number name. Writes the saved path into out (cap bytes).
// Returns false on failure (partial files are removed).
bool photo_store_save(const uint8_t *data, size_t len, int64_t ts_ms,
                      uint32_t seq, const char *reason,
                      char *out, size_t cap);

// List up to max_n pending photo paths, OLDEST first. Returns count.
int photo_store_list(char paths[][PHOTO_PATH_MAX], int max_n);

// Recover the original reason + capture time from a stored path.
void photo_store_parse(const char *path, char *reason_out, size_t reason_cap,
                       int64_t *ts_ms_out);

// Delete a stored photo (call only after a confirmed upload).
bool photo_store_delete(const char *path);

// Rough count of additional photos that fit (running-average sizing).
int photo_store_remaining(void);
