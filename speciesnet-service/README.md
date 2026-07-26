# speciesnet-service — the camera-trap specialist

**In plain words:** the dashboard backend sends a photo here and gets back
"what animals are in it, and where" from Google's open-source **SpeciesNet**
model — the same MegaDetector-family model real wildlife researchers use for
camera traps. The backend uses the answer three ways:

1. **Empty frame?** SpeciesNet sees nothing → skip Gemini entirely. This kills
   the false alarms (Gemini inventing a deer out of a ceiling light) and saves
   money, because most motion photos are empty.
2. **Person or vehicle only?** Keep those boxes, skip Gemini, keep the photo
   private.
3. **Animal?** Ask Gemini to confirm/refine the species, handing it
   SpeciesNet's answer as a starting point.

## Why there is no API key (the PR #39/#40 story)

The first SpeciesNet integration was a worker script that polled the backend
from outside, so it needed the shared `CAMERA_API_KEY` — a secret to
distribute and a public server-to-server surface to defend. It was reverted
for exactly that reason.

This service removes both problems:

- Deployed with `--no-allow-unauthenticated`: **Cloud Run's own IAM layer
  rejects every caller** before a request reaches our code. Only the identity
  holding `roles/run.invoker` — the dashboard backend's service account — can
  call it, and it proves who it is with a short-lived Google-signed ID token.
  Nothing to leak, rotate, or hand to students.
- The service itself holds **zero permissions** (its `speciesnet-runner`
  service account has no roles at all). It can't read the photo bucket or the
  database — photos arrive as bytes in the request, the answer goes back in
  the response, and that's the entire attack surface.

## API

```
POST /detect
Content-Type: image/jpeg
Body: raw JPEG bytes
Optional query: ?country=USA&admin1_region=CA   (defaults shown; geofences species)

200 → {
  modelVersion, speciesnetPackage, imageWidth, imageHeight,
  prediction, predictionScore, predictionSource,   // raw ensemble answer (debug)
  species,                                          // common name, or null
  detections: [{ category: 'animal'|'person'|'vehicle',
                 label,                             // species name or null
                 confidence,                        // 0..1
                 box: [x,y,w,h],                    // PIXELS, top-left origin
                 boxNorm: [x,y,w,h] }]              // normalized 0..1
}
```

Errors: `415` wrong content-type, `400` empty/undecodable body, `500` model
error. Detections are **not** confidence-filtered here — the backend needs the
raw list so even a faint "maybe a person" reaches the privacy gate.

`GET /healthz` → `{ok, modelLoaded}` (cheap; never triggers a model load).

## One-time setup (owner account — Alan)

```bash
# 1) A "who am I" badge for the service that grants it NOTHING.
gcloud iam service-accounts create speciesnet-runner \
  --project=louielabs-animal-cams \
  --display-name="SpeciesNet Cloud Run runtime (no permissions)"

# 2) First deploy (after this, the Cloud Build trigger takes over):
#    from the repo root —
gcloud builds submit --config speciesnet-service/cloudbuild.yaml \
  --project=louielabs-animal-cams .

# 3) Hang a lock on the front door; give the ONE key to the dashboard backend.
gcloud run services add-iam-policy-binding speciesnet-service \
  --project=louielabs-animal-cams --region=us-west1 \
  --member="serviceAccount:cloud-backend@louielabs-animal-cams.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# 4) GO LIVE — point the dashboard at the service. This reads the URL straight
#    from the deployed service, so there is nothing to copy by hand:
SN_URL=$(gcloud run services describe speciesnet-service \
  --project=louielabs-animal-cams --region=us-west1 --format='value(status.url)')
echo "$SN_URL"   # sanity check: https://speciesnet-service-....run.app

gcloud run services update wildlife-dashboard \
  --project=louielabs-animal-cams --region=us-west1 \
  --update-env-vars "SPECIESNET_SERVICE_URL=$SN_URL"

#    This setting SURVIVES future website deploys: web/cloudbuild.yaml uses
#    --update-env-vars (which merges) rather than --set-env-vars (which would
#    replace the whole env and silently wipe this, turning detection off).
#
#    Rollback at any time:
#      gcloud run services update wildlife-dashboard --project=louielabs-animal-cams \
#        --region=us-west1 --remove-env-vars SPECIESNET_SERVICE_URL
#    Analysis then stops and captures stay pending — nothing breaks.

# 5) Optional: console — create a Cloud Build trigger (like the wildwatch-site
#    one) so future changes auto-deploy: push to main, "included files" filter
#    speciesnet-service/**, build config speciesnet-service/cloudbuild.yaml.
```

## Local development (no cloud needed)

```bash
# Reuse the verified local SpeciesNet install (or make a fresh venv from
# requirements.txt — first model load downloads ~500MB from Kaggle):
~/wildlife-cam-worker/.venv/bin/pip install flask gunicorn
PORT=8080 ~/wildlife-cam-worker/.venv/bin/python speciesnet-service/app.py

# In another shell:
curl -s -X POST http://localhost:8080/detect \
  -H 'Content-Type: image/jpeg' \
  --data-binary @"$HOME/wildlife-cam-worker/test-photos/wildcam_20260627_135921.jpg" \
  | python3 -m json.tool
```

Tests (fast, no model): `python -m pytest speciesnet-service/tests -q`

The single most important pre-deploy check: `docker build` the image, then run
it **with networking disabled** and confirm `/detect` still answers — that
proves the weights really are baked in and the container never needs Kaggle.

## Tuning knobs

- `--min-instances=0` (current): idle costs nothing; first request after idle
  pays a ~40-60s cold start, during which the backend times out and falls back
  to Gemini-only for that photo (never broken, just ungated). If the
  `analyzedBy` audit shows frequent `speciesnet-down+vertex:` entries, flip to
  `--min-instances=1` in cloudbuild.yaml.
- The backend's gate floor lives in the web app (`SPECIESNET_GATE_MIN_CONFIDENCE`,
  default 0.2) — not here.
