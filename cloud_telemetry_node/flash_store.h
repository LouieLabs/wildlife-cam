#pragma once
#include <Arduino.h>
#include <FS.h>          // gives the File type
#include <LittleFS.h>    // internal-flash filesystem (replaces the microSD card)

// Internal-flash storage for captured photos, using LittleFS on the 16 MB
// chip's storage partition (see firmware/heltec-core-overrides/ -- the OTA-ready
// partition table reserves ~11.9 MB here). This REPLACES sd_store.* : the four
// microSD pins (10, 11, 15, 16) are now free for PIR / sensors, and there are no
// flaky cards. Same safety pattern as before -- save first, upload later, delete
// only after a confirmed upload -- so a photo is never lost if the (slow) upload
// fails or is interrupted.

// Mount LittleFS (formats on first boot if needed) and make sure /wildcam
// exists. Returns true on success.
bool flashInit();

// Save a JPEG to /wildcam. Filename embeds the wake reason + capture time so a
// photo uploaded on a later wake (pending-photo flow) still gets a descriptive
// cloud name. Format: /wildcam/<REASON>_<epochMs>.jpg, or /wildcam/<REASON>_seq<N>.jpg
// when NTP hasn't synced yet (tsMs == 0).
//
// reason: one of "PIR", "BUTTON", "TIMER", "COLDBOOT" -- caller derives from
// the wake cause. Returns the file path, or "" on failure.
String flashSaveJpeg(const uint8_t *data, size_t len, long long tsMs, uint32_t seq, const char *reason);

// Parse a path written by flashSaveJpeg back into reason + capture time. Used
// by the upload flow so a pending-photo upload can tell the cloud what kind of
// event triggered the original capture. Legacy "wildcam_<ts>.jpg" maps to
// reason="UNKNOWN".
void flashParsePath(const String &path, String &reasonOut, long long &tsMsOut);

// Open a saved file for reading (caller closes it).
File flashOpen(const String &path);

// Delete a saved file -- call ONLY after a confirmed upload. Returns true on ok.
bool flashDelete(const String &path);

// Fill out[] with the paths of pending (not-yet-uploaded) photos, oldest first,
// up to maxN. Returns how many were found. Used to retry leftovers from earlier
// cycles whose upload failed.
int flashListPending(String out[], int maxN);

// Rough number of photos that still fit, based on free space / average photo
// size seen so far (a conservative default until the first capture).
int picsRemaining();
