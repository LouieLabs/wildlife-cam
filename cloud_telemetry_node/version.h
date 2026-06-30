#pragma once
// Firmware version identifiers, auto-stamped at build time. Zero per-release
// human effort: every compile picks up the current git SHA + compile date/time.
//
// FW_GIT_SHA comes from build_version.h, which is regenerated before each
// build by the prebuild hook in firmware/heltec-core-overrides/platform.local.txt.
// If the hook isn't installed (or git isn't available), FW_GIT_SHA falls back
// to "dev" so the build still compiles.
//
// FW_BUILD_DATE / FW_BUILD_TIME come from the C preprocessor's __DATE__ and
// __TIME__ -- free, every build, no setup. Together with the git SHA they form
// FW_VERSION_STR, which gets printed at boot and shipped in the cloud status
// report so the dashboard can show exactly which build is on each device.

#if __has_include("build_version.h")
  #include "build_version.h"
#endif

#ifndef FW_GIT_SHA
  // Sentinel: prebuild hook didn't run (or git wasn't available). Anything
  // reporting "dev" was built off a checkout with no git context -- treat with
  // suspicion when triaging field issues.
  #define FW_GIT_SHA "dev"
#endif

#define FW_BUILD_DATE __DATE__
#define FW_BUILD_TIME __TIME__

// Human-friendly one-liner. Example: "a1b2c3d (Jun 30 2026 14:32:18)".
#define FW_VERSION_STR FW_GIT_SHA " (" FW_BUILD_DATE " " FW_BUILD_TIME ")"
