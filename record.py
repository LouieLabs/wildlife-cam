#!/usr/bin/env python3
"""record.py - record the ESP32 wildlife-cam live feed to an MP4 with a live
metadata overlay (camera name, date/time, location, temperature).

No SD card needed. Your computer pulls the camera's live MJPEG stream and, once
a second, asks the camera's /status endpoint for its current time / temperature
/ location; ffmpeg burns that text onto the bottom-left of the video while it
records to an H.264 MP4.

Requirements: ffmpeg on PATH (`brew install ffmpeg`) and Python 3.

Usage:
    python3 record.py 192.168.1.50 -o clip.mp4 --camera-name "Camera 1"
    # ...record... then press Ctrl-C to stop and finalize the file.

    python3 record.py 192.168.1.50 --seconds 30      # auto-stop after 30s
"""
import argparse, json, os, subprocess, tempfile, threading, time, urllib.request

# Default font path (macOS). On Linux try a DejaVu/Liberation .ttf instead.
DEFAULT_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def fetch_status(host):
    """Pull the camera's /status JSON (served on port 80)."""
    with urllib.request.urlopen(f"http://{host}/status", timeout=2) as r:
        return json.load(r)


def make_label(st, camera_name):
    """Build the one-line overlay string from a /status response."""
    if st.get("synced"):
        # device's local wall clock: epoch (UTC) + tz_offset, read back as UTC
        lt = time.gmtime(st["epoch"] + st["tz_offset"])
        when = time.strftime("%Y-%m-%d %H:%M:%S", lt)
    else:
        when = "(no time)"
    loc = st.get("city") or f"{st.get('lat', '?')},{st.get('lon', '?')}"
    temp = f"{round(st['weather_f'])}F" if st.get("weather_ok") else "--F"
    return f"{camera_name}  {when}  {loc}  {temp}"


def poll_loop(host, camera_name, label_path, stop):
    """Every second, refresh label.txt with the camera's current metadata."""
    while not stop.is_set():
        try:
            label = make_label(fetch_status(host), camera_name)
        except Exception:
            label = f"{camera_name}  (status unavailable)"
        # atomic write so ffmpeg never reads a half-written file
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(label_path))
        with os.fdopen(fd, "w") as f:
            f.write(label)
        os.replace(tmp, label_path)
        stop.wait(1.0)


def main():
    ap = argparse.ArgumentParser(description="Record the ESP32 cam feed with a live overlay.")
    ap.add_argument("host", help="camera IP or hostname, e.g. 192.168.1.50")
    ap.add_argument("-o", "--output", default="out.mp4")
    ap.add_argument("--camera-name", default="Camera 1")
    ap.add_argument("--stream-port", type=int, default=81)
    ap.add_argument("--fontsize", type=int, default=18)
    ap.add_argument("--font", default=DEFAULT_FONT)
    ap.add_argument("--seconds", type=int, default=0,
                    help="auto-stop after N seconds (0 = run until Ctrl-C)")
    args = ap.parse_args()

    workdir = tempfile.mkdtemp(prefix="rec_")
    label_path = os.path.join(workdir, "label.txt")
    with open(label_path, "w") as f:
        f.write(args.camera_name)

    stop = threading.Event()
    threading.Thread(
        target=poll_loop,
        args=(args.host, args.camera_name, label_path, stop),
        daemon=True,
    ).start()

    stream_url = f"http://{args.host}:{args.stream_port}/stream"
    vf = (
        f"drawtext=fontfile='{args.font}':textfile='{label_path}':reload=1:"
        f"expansion=none:x=10:y=h-th-10:fontsize={args.fontsize}:"
        f"fontcolor=white:borderw=2:bordercolor=black"
    )
    cmd = [
        "ffmpeg", "-y", "-f", "mpjpeg", "-i", stream_url,
        "-vf", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
        "-movflags", "+faststart",
    ]
    if args.seconds > 0:
        cmd += ["-t", str(args.seconds)]
    cmd += [args.output]

    print(f"recording {stream_url} -> {args.output}  (Ctrl-C to stop)")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        proc.wait()
    except KeyboardInterrupt:
        try:
            proc.communicate(b"q", timeout=10)   # let ffmpeg finalize the MP4
        except Exception:
            proc.terminate()
    finally:
        stop.set()
    print("saved", args.output)


if __name__ == "__main__":
    main()
