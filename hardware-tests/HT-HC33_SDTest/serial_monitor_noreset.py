#!/usr/bin/env python3
"""
No-reset serial monitor for the HT-HC33.

The Arduino IDE Serial Monitor toggles DTR/RTS when it opens the port, which
warm-resets the ESP32. On this board that re-inits an SD card that's already in
SPI mode, and a marginal card can fail that re-init (-> "f_mount = 3 / NOT_READY"),
even though it mounted fine on the real cold boot. This monitor holds DTR/RTS
inactive so it never resets the board -- you see the true running output.

Usage:
    python3 serial_monitor_noreset.py [port] [baud]
    # defaults: /dev/cu.usbserial-0001 115200
Ctrl-C to quit. Requires: pip3 install pyserial
"""
import sys, time
import serial

port = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbserial-0001"
baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

p = serial.Serial()
p.port = port
p.baudrate = baud
p.dtr = False          # hold reset line inactive -> do NOT reset the board
p.rts = False
p.open()
print(f"[no-reset monitor] {port} @ {baud} -- Ctrl-C to quit\n", flush=True)
try:
    while True:
        data = p.read(p.in_waiting or 1)
        if data:
            sys.stdout.write(data.decode("utf-8", "replace"))
            sys.stdout.flush()
        else:
            time.sleep(0.01)
except KeyboardInterrupt:
    pass
finally:
    p.close()
