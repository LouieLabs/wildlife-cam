# WildWatch public site → louielabs.com (handoff for Alan)

`index.html` in this folder is the **new louielabs.com**: the same WildWatch
design that's live there today, but wired to **real data** instead of the
placeholder photos. It is one self-contained static file — no build step, no
dependencies, drop-in replacement for the current page.

## What it does

| Page | Content |
|---|---|
| **Home** | Only *detections* — photos where the AI found an animal or person (boxes drawn on the photo, animal name in the card title) |
| **Library** | Every photo, newest first — search / sort / filters work against real data |
| **Live** | The real camera fleet. Deep-sleep cameras show their newest photo, auto-refreshing (they can't stream); "Request fresh photo" queues a `take_picture`. A camera running the streaming firmware on the viewer's LAN can be watched live via "Stream address…" (stored in localStorage) |
| **Settings** | Sign-in (Google, @louielabs.com) + camera admin (rename / Wi-Fi / capture settings / delete / add via the dashboard's `/provision` tool) + saved Wi-Fi networks — same APIs the admin dashboard uses |

Data comes from the existing Cloud Run backend
(`https://wildlife-dashboard-ee47ntxftq-uw.a.run.app`):
anonymous visitors get `/api/captures?publicOnly=true` (only AI-cleared photos —
no people/dogs); signing in unlocks everything else. All auth is enforced
server-side; the page only carries the public Firebase web config.

## Where the site actually lives

louielabs.com and www.louielabs.com are domain-mapped to the Cloud Run service
**`louielabs-site`** in the GCP project **`louielabs-website`** (us-west1) —
a *separate project* from the backend (`louielabs-animal-cams`). The service
is an nginx container built from this folder's `Dockerfile` (just `index.html`
+ `preview.png`, no build step).

## Already done (nothing to do here)

- **CORS**: PR #56 (merged + deployed) allowlists `https://louielabs.com`,
  `https://www.louielabs.com`, and `http://localhost:3000` on the admin routes
  (`devices`, `networks`, `command`, `rename`). Verified live: preflights return
  the right headers for these origins and nothing for others.
- **Visual verification**: all pages exercised against production data from
  `http://localhost:3000` (see PR description for screenshots/details).
- **Sign-in domains** (2026-07-13): `louielabs.com` and `www.louielabs.com`
  are in Firebase *Authentication → Settings → Authorized domains*, so the
  Google sign-in popup works on the public site.

## Deploy steps

1. **Merge to `main`.** The site auto-deploys: a Cloud Build trigger in the
   `louielabs-website` project fires on pushes to `main` that touch
   `wildwatch-site/**` and runs this folder's `cloudbuild.yaml` (build the
   nginx image, deploy `louielabs-site`). Watch it in that project's Cloud
   Build history (~2 min). Manual fallback, from `wildwatch-site/`:
   `gcloud run deploy louielabs-site --project louielabs-website --region us-west1 --source .`

2. **Smoke-test on louielabs.com**:
   - Anonymous: Home/Library show real photos; Live shows Darius Cam + LL Cam 1.
   - Sign in with a @louielabs.com account: Settings lists the cameras and
     saved networks; try a harmless action (e.g. "Take photo").

4. **Launch-day clean slate** (either admin, after PR #58 is deployed):
   sign in on the site → Settings → Public Gallery → "Hide all photos taken
   before now". Bench-test photos vanish from the public view (reversible per
   photo via the viewer's Unhide button; nothing is deleted).

## Rollback

Keep the current `index.html` — swapping it back fully reverts the site.
No schema, backend, or firmware changes depend on this page.

## Known limitations (by design, not bugs)

- AI analysis runs while any gallery/dashboard tab is open (the site pings
  `/api/analyze-cron` every 2 min — needs PR #59 deployed). For fully
  autonomous analysis, add the optional Cloud Scheduler job from PR #59's
  description.
- Photo rotation: a signed-in user's rotation is SAVED for everyone (PATCH
  /api/captures/[id] — needs PR #58 deployed); anonymous viewers' rotations
  stay localStorage, this-device-only. Per-camera stream addresses stay
  localStorage.
- The Library loads the newest 100 photos and pages back via "Load older
  photos" (deep history needs PR #58's cursor; until then it reaches only the
  newest ~200).
