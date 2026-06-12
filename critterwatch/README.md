# critterwatch

Watch a folder for newly saved photos and videos and automatically run wildlife
detection on each one, using **Google's SpeciesNet** camera-trap ensemble
(MegaDetector finds the boxes, SpeciesNet classifies the species). Output is an
annotated copy of every file plus a JSON sidecar and a rolling `detections.csv`.

Tuned for the **Santa Cruz Mountains** species set (deer, mountain lion, bobcat,
coyote, gray fox, raccoon, skunk, opossum, rabbits, squirrels, woodrat, rat,
wild pig, black bear, wild turkey) plus humans, dogs, and domestic cats —
geofenced to **USA / California** so predictions favour locally-plausible
species. Anything off the list is still boxed and labelled with its taxon.

---

## Setup

You need **Python 3.10+** (3.12 recommended) and **ffmpeg** on your PATH.

```bash
# 1. create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate

# 2. install dependencies (pulls torch + the model stack)
pip install --upgrade pip
pip install -r requirements.txt
```

Install **ffmpeg**:

| OS | Command |
|----|---------|
| macOS | `brew install ffmpeg` |
| Linux (Debian/Ubuntu) | `sudo apt-get install -y ffmpeg` |
| Windows | `winget install Gyan.FFmpeg`  (or `choco install ffmpeg`) |

> **First run downloads several GB of model weights** (the SpeciesNet classifier
> + MegaDetector + geofence data) into `~/.cache/kagglehub`. This is a one-time
> download; later runs reuse the cache.

**HEIC photos** (iPhone) are supported via `pillow-heif`, installed above — no
extra step.

---

## Run

```bash
# watch ./input, write results to ./output  (folders auto-created)
python -m critterwatch

# also process whatever is already sitting in the watch folder
python -m critterwatch --scan-existing

# process a single file and exit
python -m critterwatch process /path/to/photo.jpg
python -m critterwatch process /path/to/clip.mp4
```

Everything has a working default — `python -m critterwatch` with **zero
arguments** watches `./input` and writes to `./output` (created next to the
package). The resolved absolute paths and chosen compute device are printed on
startup.

**Compute device** is auto-detected: CUDA (NVIDIA) → Apple-Silicon MPS → CPU.
Override with `--device cpu|mps|cuda`.

### Useful flags
```
--watch-dir DIR              folder to watch          (default ./input)
--output-dir DIR             folder for results       (default ./output)
--config FILE                config.yaml path         (default ./config.yaml)
--device {auto,cuda,mps,cpu}
--frame-sample-fps N         frames/sec to sample from videos
--detector-confidence F      MegaDetector box threshold   (default 0.2)
--classifier-confidence F    SpeciesNet species threshold (default 0.5)
--scan-existing              process the backlog on startup
```
Command-line flags override `config.yaml`, which is auto-generated with defaults
on first run.

---

## Fully automatic mode (macOS) — recommended

Hands-off. The camera's Snapshot/Record buttons download files named `wildcam_*`
to Downloads; the agent files them away and annotates them automatically.

Make a `Louie Labs` folder in Downloads with two subfolders:

```
~/Downloads/Louie Labs/
  Wildlife Camera Images/
  Wildlife Camera Videos/
  Annotated/              (auto-created)
```

Install the background agent (one time):

```bash
./install_agent.sh      # start
./uninstall_agent.sh    # stop
```

On any new download, the agent:

1. moves **only** `wildcam_*` files from Downloads into **Wildlife Camera
   Images** (photos) or **Wildlife Camera Videos** (recordings), then
2. annotates them, writing the result to **`Annotated/`** (annotated copy +
   JSON sidecar + `detections.csv`).

**Safety:** the router only ever touches files whose name starts with
`wildcam_` — exactly what the camera interface produces. Every other file in
Downloads (personal photos, videos, PDFs, …) is never read or moved. Routed
camera files stay in the camera folders unmodified; annotations go to
`Annotated/`. The model loads only when there's real work.

> Recordings only auto-route after you re-flash the camera with the firmware
> that prefixes recordings with `wildcam_` (snapshots already do). You can also
> drop files into the camera folders by hand, and run one pass manually:

```bash
python -m critterwatch ingest
```

---

## Output

For every processed file, in the output folder:

- **`<name>_annotated.<ext>`** — a copy with boxes + `label 87%` drawn on
  (videos become an annotated `.mp4`). Originals are never modified or deleted.
- **`<name>.json`** — sidecar: pixel + normalized boxes, mapped label, raw
  taxonomy string, detector/classifier confidences, model version. Videos also
  carry a per-species summary (max confidence, first/last seen).
- **`detections.csv`** — one row per detection appended across all files
  (timestamp, filename, media type, label, confidence, bbox).

Box colours: **human = red, dog/cat = blue, wildlife = green, other = yellow.**

---

## Tests

```bash
pip install pytest        # already in requirements
pytest -q
```
Covers the label-mapping layer (taxon → target label) and the file-stability
check used by the watcher.

---

## How it fits the wildlife-cam project

Point `--watch-dir` at wherever your camera snapshots/recordings land (e.g. a
synced folder, or the folder `record.py` writes to) and critterwatch annotates
each new capture automatically.

## Notes / limitations

- SpeciesNet returns one image-level species prediction; for a frame with
  multiple animals, that top species is applied to the animal box(es). Humans
  and vehicles are labelled directly from MegaDetector.
- No detector is perfect — treat low-confidence boxes with judgement. Tune
  `--detector-confidence` / `--classifier-confidence` to taste.
