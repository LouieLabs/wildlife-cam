#include "camera_capture.h"
#include "node_config.h"

#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <errno.h>

#include "esp_log.h"
#include "esp_check.h"
#include "driver/i2c_master.h"
#include "esp_ldo_regulator.h"
#include "linux/videodev2.h"
#include "esp_video_init.h"
#include "esp_video_device.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// IDF's newlib ships a minimal <sys/mman.h> that declares mmap() but omits
// MAP_FAILED (it's the POSIX sentinel for a failed mapping). Define it the
// standard way if the toolchain didn't.
#ifndef MAP_FAILED
#define MAP_FAILED ((void *)-1)
#endif

static const char *TAG = "cam";

// ===========================================================================
// MIPI-CSI camera -> hardware JPEG on the Lilygo T-Halow-P4.
//
// In plain words: this board's camera is nothing like the Heltec's. THREE
// things must happen before a photo exists, and skipping ANY of them looks
// identical to "no camera attached":
//
//   1. SENSOR POWER: the rails sit behind an I2C-controlled chip (SGM38121 at
//      0x28). Nothing on the camera answers until we switch them on.
//   2. D-PHY POWER: the P4's *internal* LDO (channel 3, 1.83 V) feeds the MIPI
//      receiver. Without it the sensor can be alive and still never stream.
//   3. JPEG: the OV2710 CANNOT produce JPEG -- it emits RAW10. The ISP turns
//      that into RGB565, then the P4's hardware JPEG encoder (a separate V4L2
//      memory-to-memory device at /dev/video10) compresses it. That encoder
//      only exists when CONFIG_ESP_VIDEO_ENABLE_HW_JPEG_VIDEO_DEVICE=y.
//
// Pipeline: sensor RAW10 -> ISP -> RGB565 @ /dev/video0 -> M2M -> JPEG @ /dev/video10
//
// Register values, the LDO requirement, and the M2M sequence are read from
// Lilygo's + Espressif's own examples, not guessed. Citations in
// docs/PLAN-lilygo-p4-port.md.
// ===========================================================================

// --- SGM38121 camera PMIC (I2C 0x28, shared bus: SDA 7 / SCL 8) -------------
#define PMIC_ADDR        0x28
#define PMIC_REG_ID      0x00   // reads 0x80
#define PMIC_REG_DVDD1   0x03
#define PMIC_REG_AVDD1   0x05
#define PMIC_REG_AVDD2   0x06
#define PMIC_REG_ENABLE  0x0E   // bit0 DVDD_1, bit1 DVDD_2, bit2 AVDD_1, bit3 AVDD_2
// Voltage codes. The vendor driver computes reg=(mV-504)/8 for DVDD and
// (mV-1348)/8 for AVDD with integer truncation, so the rails actually land at
// 1496 / 1700 / 2996 mV. Reproduced exactly rather than "corrected" to nominal.
#define PMIC_VAL_DVDD1   0x7C   // 1500 mV -> 1496
#define PMIC_VAL_AVDD1   0x2C   // 1700 mV
#define PMIC_VAL_AVDD2   0xCE   // 3000 mV -> 2996

#define CAM_I2C_PORT     I2C_NUM_1
#define CAM_I2C_SDA      7
#define CAM_I2C_SCL      8
#define CAM_I2C_FREQ     100000

// P4 internal LDO powering the MIPI D-PHY. Acquired and never released -- the
// rail must stay up for as long as the camera streams.
#define MIPI_LDO_CHAN    3
#define MIPI_LDO_MV      1830

// Drop the first frames so auto-exposure settles (same lesson as the Heltec
// build: the first frames come out dark/green).
#define SKIP_STARTUP_FRAMES 2
#define JPEG_QUALITY        80
#define CAPTURE_BUF_COUNT   2      // the CSI driver requires > 1

static i2c_master_bus_handle_t s_i2c_bus;
static i2c_master_dev_handle_t s_pmic;
static esp_ldo_channel_handle_t s_mipi_ldo;

static int s_cap_fd = -1;             // /dev/video0  (sensor -> RGB565)
static int s_m2m_fd = -1;             // /dev/video10 (RGB565 -> JPEG)
static uint8_t *s_cap_buf[CAPTURE_BUF_COUNT];
static uint8_t *s_jpeg_buf;           // mmapped encoder output
static uint32_t s_cap_fmt;            // pixel format the sensor path produced
static bool s_streaming;

// --- SGM38121 helpers -------------------------------------------------------

static esp_err_t pmic_write(uint8_t reg, uint8_t val) {
  uint8_t b[2] = { reg, val };
  return i2c_master_transmit(s_pmic, b, sizeof(b), 1000);
}

static esp_err_t pmic_read(uint8_t reg, uint8_t *val) {
  return i2c_master_transmit_receive(s_pmic, &reg, 1, val, 1, 1000);
}

// Enable ONE rail without disturbing the others. Read-modify-write matters:
// blindly writing the register would clear bits for rails we never configured
// (DVDD_2's power-on default, and what it feeds, are undocumented here).
static esp_err_t pmic_enable_rail(uint8_t bit) {
  uint8_t v = 0;
  ESP_RETURN_ON_ERROR(pmic_read(PMIC_REG_ENABLE, &v), TAG, "enable read failed");
  return pmic_write(PMIC_REG_ENABLE, v | bit);
}

static esp_err_t camera_power_on(void) {
  if (s_pmic) return ESP_OK;   // already powered this wake

  i2c_master_bus_config_t bus_cfg = {
    .i2c_port = CAM_I2C_PORT,
    .sda_io_num = CAM_I2C_SDA,
    .scl_io_num = CAM_I2C_SCL,
    .clk_source = I2C_CLK_SRC_DEFAULT,
    .glitch_ignore_cnt = 7,
    .flags.enable_internal_pullup = true,
  };
  ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s_i2c_bus), TAG, "i2c bus init failed");

  i2c_device_config_t dev_cfg = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = PMIC_ADDR,
    .scl_speed_hz = CAM_I2C_FREQ,
  };
  ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(s_i2c_bus, &dev_cfg, &s_pmic), TAG, "pmic attach failed");

  uint8_t id = 0;
  ESP_RETURN_ON_ERROR(pmic_read(PMIC_REG_ID, &id), TAG,
                      "camera PMIC did not answer on I2C -- is a camera board attached?");
  ESP_RETURN_ON_FALSE(id == 0x80, ESP_ERR_NOT_FOUND, TAG,
                      "bad PMIC id 0x%02x (expected 0x80)", id);

  // Voltages first, then enables -- the order the vendor driver uses.
  ESP_RETURN_ON_ERROR(pmic_write(PMIC_REG_DVDD1, PMIC_VAL_DVDD1), TAG, "DVDD1 set failed");
  ESP_RETURN_ON_ERROR(pmic_write(PMIC_REG_AVDD1, PMIC_VAL_AVDD1), TAG, "AVDD1 set failed");
  ESP_RETURN_ON_ERROR(pmic_write(PMIC_REG_AVDD2, PMIC_VAL_AVDD2), TAG, "AVDD2 set failed");
  ESP_RETURN_ON_ERROR(pmic_enable_rail(1 << 0), TAG, "DVDD1 enable failed");
  ESP_RETURN_ON_ERROR(pmic_enable_rail(1 << 2), TAG, "AVDD1 enable failed");
  ESP_RETURN_ON_ERROR(pmic_enable_rail(1 << 3), TAG, "AVDD2 enable failed");

  // The P4's OWN LDO for the MIPI D-PHY -- a different chip from the PMIC
  // above; both are required. Deliberately never released.
  if (!s_mipi_ldo) {
    esp_ldo_channel_config_t ldo = { .chan_id = MIPI_LDO_CHAN, .voltage_mv = MIPI_LDO_MV };
    ESP_RETURN_ON_ERROR(esp_ldo_acquire_channel(&ldo, &s_mipi_ldo), TAG, "MIPI D-PHY LDO failed");
  }

  vTaskDelay(pdMS_TO_TICKS(100));   // rails settle (the vendor's only delay)
  ESP_LOGI(TAG, "camera rails up (PMIC id 0x%02x + D-PHY LDO)", id);
  return ESP_OK;
}

// --- V4L2 plumbing ----------------------------------------------------------

// Ask the encoder which input formats it accepts, rather than assuming.
static bool m2m_accepts(uint32_t fmt) {
  struct v4l2_fmtdesc d = { .index = 0, .type = V4L2_BUF_TYPE_VIDEO_OUTPUT };
  while (ioctl(s_m2m_fd, VIDIOC_ENUM_FMT, &d) == 0) {
    if (d.pixelformat == fmt) return true;
    d.index++;
  }
  return false;
}

static bool open_capture_device(void) {
  s_cap_fd = open(ESP_VIDEO_MIPI_CSI_DEVICE_NAME, O_RDONLY);
  if (s_cap_fd < 0) {
    ESP_LOGE(TAG, "open %s failed (errno %d) -- sensor not detected on CSI",
             ESP_VIDEO_MIPI_CSI_DEVICE_NAME, errno);
    return false;
  }

  // Use the sensor's native resolution (chosen by Kconfig) rather than forcing
  // one the driver may not support.
  struct v4l2_format fmt = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
  if (ioctl(s_cap_fd, VIDIOC_G_FMT, &fmt) != 0) {
    ESP_LOGE(TAG, "G_FMT failed (errno %d)", errno);
    return false;
  }
  fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_RGB565;   // an ISP output the encoder eats
  if (ioctl(s_cap_fd, VIDIOC_S_FMT, &fmt) != 0) {
    ESP_LOGE(TAG, "S_FMT RGB565 failed (errno %d)", errno);
    return false;
  }
  s_cap_fmt = fmt.fmt.pix.pixelformat;
  ESP_LOGI(TAG, "sensor: %ux%u", (unsigned)fmt.fmt.pix.width, (unsigned)fmt.fmt.pix.height);

  struct v4l2_requestbuffers req = {
    .count = CAPTURE_BUF_COUNT,
    .type = V4L2_BUF_TYPE_VIDEO_CAPTURE,
    .memory = V4L2_MEMORY_MMAP,
  };
  if (ioctl(s_cap_fd, VIDIOC_REQBUFS, &req) != 0) {
    ESP_LOGE(TAG, "REQBUFS failed (errno %d) -- PSRAM enabled?", errno);
    return false;
  }
  for (int i = 0; i < CAPTURE_BUF_COUNT; i++) {
    struct v4l2_buffer b = {
      .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP, .index = i,
    };
    if (ioctl(s_cap_fd, VIDIOC_QUERYBUF, &b) != 0) return false;
    s_cap_buf[i] = mmap(NULL, b.length, PROT_READ | PROT_WRITE, MAP_SHARED, s_cap_fd, b.m.offset);
    if (s_cap_buf[i] == MAP_FAILED) { ESP_LOGE(TAG, "mmap %d failed", i); return false; }
    if (ioctl(s_cap_fd, VIDIOC_QBUF, &b) != 0) return false;
  }
  int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
  return ioctl(s_cap_fd, VIDIOC_STREAMON, &type) == 0;
}

static bool open_encoder_device(void) {
  s_m2m_fd = open(ESP_VIDEO_JPEG_DEVICE_NAME, O_RDWR);
  if (s_m2m_fd < 0) {
    ESP_LOGE(TAG, "open %s failed (errno %d) -- CONFIG_ESP_VIDEO_ENABLE_HW_JPEG_VIDEO_DEVICE=y?",
             ESP_VIDEO_JPEG_DEVICE_NAME, errno);
    return false;
  }
  if (!m2m_accepts(s_cap_fmt)) {
    ESP_LOGE(TAG, "JPEG encoder rejects capture format 0x%08x", (unsigned)s_cap_fmt);
    return false;
  }

  // JPEG quality -- must be set before streaming.
  struct v4l2_ext_control ctrl = {
    .id = V4L2_CID_JPEG_COMPRESSION_QUALITY,
    .value = JPEG_QUALITY,
  };
  struct v4l2_ext_controls ctrls = {
    .ctrl_class = V4L2_CID_JPEG_CLASS,
    .count = 1,
    .controls = &ctrl,
  };
  if (ioctl(s_m2m_fd, VIDIOC_S_EXT_CTRLS, &ctrls) != 0) {
    ESP_LOGW(TAG, "could not set JPEG quality (errno %d) -- using driver default", errno);
  }

  struct v4l2_format cur = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
  if (ioctl(s_cap_fd, VIDIOC_G_FMT, &cur) != 0) return false;
  const uint32_t w = cur.fmt.pix.width, h = cur.fmt.pix.height;

  // Encoder INPUT: we hand it the capture buffer directly, so USERPTR (no copy).
  struct v4l2_format in = {
    .type = V4L2_BUF_TYPE_VIDEO_OUTPUT,
    .fmt.pix = { .width = w, .height = h, .pixelformat = s_cap_fmt },
  };
  if (ioctl(s_m2m_fd, VIDIOC_S_FMT, &in) != 0) { ESP_LOGE(TAG, "m2m S_FMT in failed"); return false; }
  struct v4l2_requestbuffers rin = {
    .count = 1, .type = V4L2_BUF_TYPE_VIDEO_OUTPUT, .memory = V4L2_MEMORY_USERPTR,
  };
  if (ioctl(s_m2m_fd, VIDIOC_REQBUFS, &rin) != 0) return false;

  // Encoder OUTPUT: the JPEG we upload -> MMAP.
  struct v4l2_format out = {
    .type = V4L2_BUF_TYPE_VIDEO_CAPTURE,
    .fmt.pix = { .width = w, .height = h, .pixelformat = V4L2_PIX_FMT_JPEG },
  };
  if (ioctl(s_m2m_fd, VIDIOC_S_FMT, &out) != 0) { ESP_LOGE(TAG, "m2m S_FMT out failed"); return false; }
  struct v4l2_requestbuffers rout = {
    .count = 1, .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP,
  };
  if (ioctl(s_m2m_fd, VIDIOC_REQBUFS, &rout) != 0) return false;

  struct v4l2_buffer jb = {
    .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP, .index = 0,
  };
  if (ioctl(s_m2m_fd, VIDIOC_QUERYBUF, &jb) != 0) return false;
  s_jpeg_buf = mmap(NULL, jb.length, PROT_READ | PROT_WRITE, MAP_SHARED, s_m2m_fd, jb.m.offset);
  if (s_jpeg_buf == MAP_FAILED) { ESP_LOGE(TAG, "jpeg mmap failed"); return false; }
  if (ioctl(s_m2m_fd, VIDIOC_QBUF, &jb) != 0) return false;

  int t_cap = V4L2_BUF_TYPE_VIDEO_CAPTURE, t_out = V4L2_BUF_TYPE_VIDEO_OUTPUT;
  return ioctl(s_m2m_fd, VIDIOC_STREAMON, &t_cap) == 0 &&
         ioctl(s_m2m_fd, VIDIOC_STREAMON, &t_out) == 0;
}

// Pull one raw frame and drop it (exposure settling).
static void discard_frame(void) {
  struct v4l2_buffer b = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
  if (ioctl(s_cap_fd, VIDIOC_DQBUF, &b) == 0) ioctl(s_cap_fd, VIDIOC_QBUF, &b);
}

bool camera_init(void) {
  if (s_streaming) return true;

  if (camera_power_on() != ESP_OK) return false;

  // esp_video probes the sensor over SCCB on the bus we already opened, so
  // hand it that handle instead of letting it stand up a second I2C master on
  // the same pins (init_sccb = false).
  esp_video_init_csi_config_t csi = {
    .sccb_config = {
      .init_sccb = false,
      .i2c_handle = s_i2c_bus,
      .freq = CAM_I2C_FREQ,
    },
    .reset_pin = -1,   // this board ties CAM_RST to an RC power-on reset
    .pwdn_pin  = -1,   // and exposes no power-down GPIO
  };
  esp_video_init_config_t vcfg = { .csi = &csi };
  esp_err_t err = esp_video_init(&vcfg);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "esp_video_init failed: %s -- sensor probe failed (module attached? Kconfig sensor right?)",
             esp_err_to_name(err));
    return false;
  }

  if (!open_capture_device() || !open_encoder_device()) {
    camera_deinit();
    return false;
  }
  for (int i = 0; i < SKIP_STARTUP_FRAMES; i++) discard_frame();
  s_streaming = true;
  ESP_LOGI(TAG, "camera ready (RGB565 -> hardware JPEG q%d)", JPEG_QUALITY);
  return true;
}

camera_frame_t camera_capture(void) {
  camera_frame_t out = { .buf = NULL, .len = 0 };
  if (!s_streaming) return out;

  // Raw frame from the sensor.
  struct v4l2_buffer cap = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
  if (ioctl(s_cap_fd, VIDIOC_DQBUF, &cap) != 0) {
    ESP_LOGE(TAG, "capture DQBUF failed (errno %d)", errno);
    return out;
  }

  // Hand that buffer straight to the encoder (no copy), then collect the JPEG.
  struct v4l2_buffer enc_in = {
    .type = V4L2_BUF_TYPE_VIDEO_OUTPUT,
    .memory = V4L2_MEMORY_USERPTR,
    .index = 0,
    .m.userptr = (unsigned long)s_cap_buf[cap.index],
    .length = cap.length,
    .bytesused = cap.bytesused,
  };
  struct v4l2_buffer enc_out = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };

  bool ok = ioctl(s_m2m_fd, VIDIOC_QBUF, &enc_in) == 0 &&
            ioctl(s_m2m_fd, VIDIOC_DQBUF, &enc_out) == 0;
  ioctl(s_cap_fd, VIDIOC_QBUF, &cap);          // recycle the raw buffer either way
  if (ok) ioctl(s_m2m_fd, VIDIOC_DQBUF, &enc_in);
  if (!ok) {
    ESP_LOGE(TAG, "JPEG encode failed (errno %d)", errno);
    return out;
  }

  out.buf = s_jpeg_buf;
  out.len = enc_out.bytesused;
  // The encoder's output buffer must be re-queued before the next capture --
  // camera_return() does that, so the caller MUST call it (same contract as
  // the Heltec build's cameraReturn()).
  return out;
}

void camera_return(camera_frame_t *f) {
  if (!f || !f->buf || !s_streaming) return;
  struct v4l2_buffer jb = {
    .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP, .index = 0,
  };
  ioctl(s_m2m_fd, VIDIOC_QBUF, &jb);
  f->buf = NULL;
  f->len = 0;
}

void camera_deinit(void) {
  if (s_m2m_fd >= 0) {
    int t_cap = V4L2_BUF_TYPE_VIDEO_CAPTURE, t_out = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    ioctl(s_m2m_fd, VIDIOC_STREAMOFF, &t_cap);
    ioctl(s_m2m_fd, VIDIOC_STREAMOFF, &t_out);
    close(s_m2m_fd);
    s_m2m_fd = -1;
  }
  if (s_cap_fd >= 0) {
    int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(s_cap_fd, VIDIOC_STREAMOFF, &type);
    close(s_cap_fd);
    s_cap_fd = -1;
  }
  if (s_streaming) esp_video_deinit();
  s_streaming = false;
  // Rails + LDO intentionally stay up: another capture this wake reuses them,
  // and deep sleep cuts everything anyway.
}
