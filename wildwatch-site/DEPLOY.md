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

## Already done (nothing to do here)

- **CORS**: PR #56 (merged + deployed) allowlists `https://louielabs.com`,
  `https://www.louielabs.com`, and `http://localhost:3000` on the admin routes
  (`devices`, `networks`, `command`, `rename`). Verified live: preflights return
  the right headers for these origins and nothing for others.
- **Visual verification**: all pages exercised against production data from
  `http://localhost:3000` (see PR description for screenshots/details).

## Deploy steps

1. **Swap the file.** louielabs.com currently serves a single static
   `index.html` (nginx-style etag, last-modified 2026-06-22) from a Google-
   hosted service behind `ghs.googlehosted.com` — the same setup you deployed
   the mockup to. Replace that file with `wildwatch-site/index.html` from this
   repo and redeploy/restart the service. (If it's a Cloud Run nginx container:
   rebuild the image with the new file, `gcloud run deploy`. If it's simpler
   than that, you know your setup best.)

2. **Authorize the domain for sign-in** (once): Firebase console →
   *Authentication → Settings → Authorized domains* → add `louielabs.com`
   (and `www.louielabs.com` if it resolves). Without this the Google sign-in
   popup on louielabs.com fails with `auth/unauthorized-domain`; the anonymous
   gallery still works.

3. **Smoke-test on louielabs.com**:
   - Anonymous: Home/Library show real photos; Live shows Darius Cam + LL Cam 1.
   - Sign in with a @louielabs.com account: Settings lists the cameras and
     saved networks; try a harmless action (e.g. "Take photo").

## Rollback

Keep the current `index.html` — swapping it back fully reverts the site.
No schema, backend, or firmware changes depend on this page.

## Known limitations (by design, not bugs)

- Every animal currently shows as "Unknown" — the Gemini labeling isn't naming
  species yet, so Home is empty until the AI starts finding animals/people.
  The boxes + titles light up automatically once it does.
- AI analysis of new photos is triggered while dashboard/gallery pages are
  open (`/api/analyze-pending`); a scheduled trigger is a good follow-up.
- View-only photo rotation and per-browser stream addresses are localStorage,
  not synced.
