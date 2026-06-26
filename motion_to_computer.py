#!/usr/bin/env python3
"""
motion_to_computer.py — save a snapshot to THIS computer whenever the wildlife
cam detects motion. No browser, no "allow downloads" prompts.

How it works (plain words):
  The camera can't reach your computer's hard drive on its own, so this little
  program runs on your computer instead. It asks the camera "any motion yet?"
  twice a second (the camera's /motion counter). Each time that counter goes up,
  it grabs a photo from the camera (/capture) and saves it to a folder.

Setup:
  1. Find the camera's address — it's the same one you open the web page at, e.g.
     192.168.1.50 (the Serial Monitor prints ">>> Open: http://192.168.x.x/").
  2. Run it:
        python3 motion_to_computer.py 192.168.1.50
     Leave it running (Ctrl-C to stop). Files are named wildcam_<date>_<time>.jpg
     and saved to your Downloads folder by default, so the critterwatch detector
     picks them up automatically. Use --out to choose a different folder.

Examples:
     python3 motion_to_computer.py 192.168.1.50
     python3 motion_to_computer.py 192.168.1.50 --out ~/Desktop/cam
     python3 motion_to_computer.py 192.168.1.50 --poll 0.25   # check 4x/sec
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.request


def fetch_json(url, timeout=4):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def save_snapshot(base_url, out_dir):
    """Grab one JPEG from the camera and write it to out_dir. Returns the path."""
    url = f"{base_url}/capture?t={int(time.time() * 1000)}"
    with urllib.request.urlopen(url, timeout=8) as r:
        data = r.read()
    if not data:
        raise ValueError("camera returned an empty image")
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(out_dir, f"wildcam_{stamp}.jpg")
    n = 1
    while os.path.exists(path):  # two in the same second -> keep both
        path = os.path.join(out_dir, f"wildcam_{stamp}_{n}.jpg")
        n += 1
    with open(path, "wb") as f:
        f.write(data)
    return path


def main():
    ap = argparse.ArgumentParser(description="Save a snapshot on every motion event.")
    ap.add_argument("ip", help="camera IP address, e.g. 192.168.1.50")
    ap.add_argument("--out", default="~/Downloads",
                    help="folder to save snapshots into (default: ~/Downloads)")
    ap.add_argument("--poll", type=float, default=0.5,
                    help="seconds between motion checks (default: 0.5)")
    args = ap.parse_args()

    base_url = f"http://{args.ip}"
    out_dir = os.path.expanduser(args.out)
    os.makedirs(out_dir, exist_ok=True)

    print(f"Watching {base_url}/motion")
    print(f"Saving snapshots to {out_dir}")
    print("Leave this running. Press Ctrl-C to stop.\n")

    last_seq = None        # None until the first successful read (so we don't fire on a backlog)
    warned_offline = False

    while True:
        try:
            j = fetch_json(f"{base_url}/motion")
            warned_offline = False
            seq = j.get("seq")
            armed = j.get("armed", False)

            if last_seq is None:
                last_seq = seq
                print(f"Connected. Motion counter starts at {seq}; "
                      f"sensor {'armed' if armed else 'still warming up'}.")
            elif seq is not None and seq > last_seq:
                events = seq - last_seq
                last_seq = seq
                try:
                    path = save_snapshot(base_url, out_dir)
                    extra = f" (+{events - 1} more while saving)" if events > 1 else ""
                    print(f"motion -> saved {os.path.basename(path)}{extra}")
                except Exception as e:
                    print(f"motion, but capture failed: {e}")
        except KeyboardInterrupt:
            raise
        except Exception as e:
            if not warned_offline:
                print(f"can't reach the camera at {base_url} ({e}) — retrying…")
                warned_offline = True

        try:
            time.sleep(args.poll)
        except KeyboardInterrupt:
            raise


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
        sys.exit(0)
