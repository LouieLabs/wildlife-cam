#pragma once
// Firmware version string reported to the dashboard. The compile date/time is
// free from the preprocessor; a git-SHA prebuild hook (like the Heltec core
// override) can be added when this board joins the Cloud Build pipeline.
#ifndef FW_GIT_SHA
#define FW_GIT_SHA "dev"
#endif

static inline const char *fw_version_str(void) {
  return FW_GIT_SHA " (" __DATE__ " " __TIME__ ")";
}
