# Admin runbook — spinning up a student build repo

How to set up a new student-facing build repo (Vite + React + Firebase Hosting)
with **keyless** CI deploys via Workload Identity Federation. Used to create
[`LouieLabs/wildwatch-cam-viewer`](https://github.com/LouieLabs/wildwatch-cam-viewer)
on 2026-06-28; re-use the same flow for any future student project.

> **Plain-English summary.** This sets up a starter repo so 2–3 students can each
> build their own version of a web feature in parallel — each on their own branch
> with their own preview URL — and the admin merges the best parts into a final
> live version. No JSON keys live on disk anywhere; GitHub Actions and Google
> Cloud trust each other directly via short-lived tokens.

---

## What you end up with

| Piece | Owner | Notes |
| --- | --- | --- |
| `LouieLabs/<repo-name>` on GitHub | Personal user account `LouieLabs` | Public; collaborators get push but not admin |
| Firebase Hosting site `<repo-name>` | `louielabs-animal-cams` Firebase project | Multi-site hosting — shares Auth/Firestore/GCS with everything else |
| Workload Identity Pool `github-pool` | `louielabs-animal-cams` GCP project | Trusts GitHub Actions OIDC tokens |
| Service account `github-<repo-name>-deployer` | `louielabs-animal-cams` GCP project | `roles/firebasehosting.admin`; no key |
| GitHub Actions `live.yml` + `preview.yml` | Inside the new repo | Authenticates via WIF, deploys via `firebase-tools` |

---

## Why WIF and not a service-account key

The org policy `iam.disableServiceAccountKeyCreation` is enforced and we want to
keep it that way — leaked JSON keys are one of the most common GCP compromise
vectors. WIF avoids the issue entirely: GitHub Actions ships with a built-in
OIDC identity token, GCP is configured to trust it from a specific repo, and
GCP exchanges that token for a short-lived access token at workflow runtime.
Nothing long-lived ever lives on disk.

The deploy uses `firebase-tools` directly, not `FirebaseExtended/action-hosting-deploy@v0`,
because that action hard-requires a `firebaseServiceAccount` input and won't
fall back to ambient ADC even when `google-github-actions/auth@v2` has set it.

---

## Prerequisites

- `admin@louielabs.com` Google account, with Project Owner on `louielabs-animal-cams`
- `gcloud` and `firebase-tools` installed locally
  ```bash
  brew install --cask google-cloud-sdk
  npm install -g firebase-tools
  ```
- A free-text repo name. Convention: kebab-case, project-scoped (e.g.
  `wildwatch-cam-viewer`, `wildlife-trail-stats-dashboard`).
- The Vite + React + Firebase Auth scaffold (the one used for `wildwatch-cam-viewer`
  lives at `<scratchpad>/wildwatch-cam-viewer/` after running [scaffolding
  steps](#scaffold-the-app)). For now copy that template and replace strings.

---

## End-to-end checklist

In rough order. About 20 minutes if everything goes smoothly.

### 1. Sign in as `admin@louielabs.com`

```bash
gcloud auth login admin@louielabs.com
gcloud config set project louielabs-animal-cams
gcloud config set auth/reauth_use_google_auth true  # makes passkey work for reauth prompts
firebase login                                       # browser flow, same account
```

### 2. Create the GitHub repo

Web UI (you must be signed in to github.com as `LouieLabs`, not `aplouie`):

1. github.com → "+" → **New repository**
2. Owner: `LouieLabs`. Name: `<repo-name>`. Public.
3. **Unchecked** README/.gitignore/license (the scaffold provides them).
4. **Create repository**.
5. **Settings → Collaborators → Add people** → invite `aplouie` (you) so you can push.

> **Note on permissions:** `LouieLabs` is a personal user account, not an org —
> collaborators only get a `write` role tier (no admin). Admin tasks (secrets,
> branch protection, adding *more* collaborators) require signing in as
> `LouieLabs`. Use an incognito window to switch accounts without losing the
> primary session.

### 3. Create the Firebase Hosting site

From CLI is more reliable than the web wizard (the wizard has a tendency to
show a stub onboarding page for a stale period of time):

```bash
firebase hosting:sites:create <repo-name> --project louielabs-animal-cams
firebase hosting:sites:list  --project louielabs-animal-cams   # verify
```

Site URL is `https://<repo-name>.web.app`.

### 4. Authorize the new domain for Firebase Auth

Firebase Auth only allows the project's primary `firebaseapp.com` + `web.app`
domains by default. Every new Hosting site you add needs to be added to the
allowlist or Google sign-in will fail with a flashing-popup-that-closes.

Web UI: `https://console.firebase.google.com/project/louielabs-animal-cams/authentication/settings`
→ **Authorized domains** → **Add domain** → `<repo-name>.web.app` → **Add**.

(Preview channel URLs of the form `<repo-name>--<branch>-xxxx.web.app` inherit
from `web.app` and don't need separate entries — confirmed working.)

### 5. Set up Workload Identity Federation

The script [`scripts/setup_wif.sh`](../scripts/setup_wif.sh) does this end-to-end
and is idempotent. For a new repo, edit the `REPO=`, `SA_NAME=`, and (only if
sharing the pool with multiple repos) `POOL_ID=`/`PROVIDER_ID=` constants at
the top, then:

```bash
bash scripts/setup_wif.sh
```

What it does:

1. Enables `iamcredentials.googleapis.com` and `sts.googleapis.com`.
2. Creates a deployer service account `github-<repo>-deployer@…` with `roles/firebasehosting.admin`.
3. Creates a Workload Identity Pool `github-pool` (reusable across repos).
4. Creates an OIDC provider that trusts GitHub Actions tokens **only from `LouieLabs/*` repos** (`attribute-condition="assertion.repository_owner=='LouieLabs'"`).
5. Grants `principalSet://…/attribute.repository/LouieLabs/<repo>` impersonation on the SA.

Prints the values for the next step.

**Common stumble:** step 6 may fail with `PERMISSION_DENIED: iam.serviceAccounts.setIamPolicy`
even when you're project Owner. Fix: `gcloud auth login admin@louielabs.com`
(fresh OAuth flow forces reauth and the permission comes back).

### 6. Add GitHub variables + secrets

In the new repo, while signed in as `LouieLabs` (admin):

**Variables** (`Settings → Secrets and variables → Actions → Variables tab`):

| Name | Value |
| --- | --- |
| `WIF_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `WIF_SA_EMAIL` | `github-<repo>-deployer@louielabs-animal-cams.iam.gserviceaccount.com` |

**Secrets** (Secrets tab, same page):

| Name | Where it comes from |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | Firebase console → Project settings → General → Your apps → web app `firebaseConfig.apiKey` |
| `VITE_FIREBASE_APP_ID` | Same place, `firebaseConfig.appId` |

> Create a *separate* Firebase web app entry per repo (Project settings →
> General → "Add app" → Web → nickname matches the repo). Keeps console clarity
> and separates Analytics segmentation if it's ever enabled.

### 7. Push the scaffold

Copy the scaffold template, change the few project-name strings, and push as
`aplouie`:

```bash
# in a fresh dir:
cp -r <template-path>/wildwatch-cam-viewer ./<repo-name>
cd <repo-name>

# Edit at minimum:
#   .firebaserc           — change the hosting target alias
#   firebase.json         — change "target"
#   .github/workflows/*   — change `wildwatch-cam-viewer` references
#   README.md             — update repo name and clone URL
#   package.json          — change "name"

git init -b main
git add .
git commit -m "Initial scaffold"
git remote add origin https://github.com/LouieLabs/<repo-name>.git
git push -u origin main
```

### 8. Watch the deploy

```bash
gh run watch --repo LouieLabs/<repo-name> --exit-status
curl -sI https://<repo-name>.web.app | head -1   # expect HTTP/2 200
```

If you see `Error: Input required and not supplied: firebaseServiceAccount`,
the workflow is still using the FirebaseExtended action — swap to the
direct `firebase-tools` deploy form (see `wildwatch-cam-viewer/.github/workflows/`).

### 9. Invite students

`Settings → Collaborators → Add people` per student.

Each student then:

```bash
git clone https://github.com/LouieLabs/<repo-name>.git
cd <repo-name>
npm install
npm run dev
# (build a feature on a feature/<name>-* branch — preview URL gets posted in their PR)
```

---

## What the students actually get

- A `localhost:5173` dev server with 50 realistic mock captures
- Google sign-in restricted to `@louielabs.com`
- A `fetchCaptures()` API that returns `CaptureCard[]` — same call works against
  mocks and the live backend later
- A preview URL per push (via Firebase Hosting preview channels)
- A clear `src/components/` folder to build into

See [`docs/wildwatch-student-guide.md`](wildwatch-student-guide.md) for the
student-facing version.

---

## Things that bit us, and how

| Symptom | Cause | Fix |
| --- | --- | --- |
| `gh repo create LouieLabs/...` → "cannot create a repository for LouieLabs" | `LouieLabs` is a user account, not an org; only the user themselves can create repos | Create from web UI as `admin@louielabs.com`; add `aplouie` as collaborator |
| Firebase service account "key creation not allowed" | Org policy `iam.disableServiceAccountKeyCreation` | Don't fight it — use WIF instead (this runbook) |
| `gcloud iam ... PERMISSION_DENIED: setIamPolicy` even as Owner | Reauth required for sensitive ops, silently failing in CLI flow | `gcloud auth login admin@louielabs.com` (fresh) — passes the reauth challenge in browser |
| Sign-in popup flashes for ~100ms and closes silently | The new Hosting domain isn't in Firebase Auth's authorized domains list | Console → Authentication → Settings → Authorized domains → add `<repo>.web.app` |
| `Error: Input required and not supplied: firebaseServiceAccount` | `FirebaseExtended/action-hosting-deploy@v0` hard-requires that input even when ADC is set | Replace with direct `firebase-tools` deploy (uses ambient ADC from `google-github-actions/auth@v2`) |
| Node 20 deprecation warning in Actions | The action authors haven't released Node 24 builds yet | Ignore — the runner forces Node 24, nothing breaks |

---

## Scaffold the app

(See `scratchpad/wildwatch-cam-viewer/` for the working template.) Key choices:

- **Vite + React + Tailwind** — fast dev server, no TypeScript by default (students can opt in)
- **`src/auth/firebase.js`** — Firebase Auth client with `hd: 'louielabs.com'`
- **`src/api/fetchCaptures.js`** — toggles between mocks and live backend via `VITE_USE_MOCKS`
- **`src/api/mockData.js`** — 50 realistic captures (deer/raccoon/squirrel/etc.) with `temperatureF` + `humidityPercent`
- **`src/components/` empty** — student work goes there
- **`.github/workflows/live.yml`** — deploy `main` to live channel
- **`.github/workflows/preview.yml`** — deploy non-`main` to per-branch preview channel + post URL on PR

The scaffold builds with `npm run build` to a `dist/` folder Firebase Hosting picks up.
