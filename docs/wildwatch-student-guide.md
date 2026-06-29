# WildWatch — Camera Gallery Student Build Guide

> **LouieLabs · louielabs.com · GCP project: `louielabs-animal-cams`**

**Your mission:** Design and build the wildlife camera image gallery for louielabs.com. You own the visual design and the gallery component entirely — login, database, and image processing are all pre-built and handed to you. This guide tells you exactly what to build, what tools to use, and gives you the prompts to paste into those tools.

---

## Contents

1. [How the Whole System Works](#01--how-the-whole-system-works)
2. [What You're Building](#02--what-youre-building)
3. [Setting Up the Repo](#03--setting-up-the-repo)
4. [The Data You're Working With](#04--the-data-youre-working-with)
5. [Design Tools and How to Use Them](#05--design-tools-and-how-to-use-them)
6. [Prompt for Google Stitch](#06--prompt-for-google-stitch)
7. [Prompt for Claude](#07--prompt-for-claude)
8. [Iteration Workflow](#08--iteration-workflow)
9. [Definition of Done](#09--definition-of-done)
10. [Quick Reference](#10--quick-reference)

---

## 01 — How the Whole System Works

louielabs.com is a family portal made of independent sections. Firebase Hosting is the front door — it owns the domain, handles security, and routes visitors to the right section. Each section is a separate app; you're building just the camera gallery section.

### Architecture

```
DNS / Users
├── louielabs.com           Custom domain → Firebase Hosting
├── cam.louielabs.com       Subdomain (or /cameras rewrite)
├── TLS / CDN               Firebase manages certificates
└── Google Auth             @louielabs.com sign-in

        ↓ routes by path / subdomain ↓

Front Door — Firebase Hosting
├── Custom Domain           louielabs.com front page
├── Rewrites                Routes paths to section apps
├── Firebase Auth           Google sign-in + custom claims
└── CDN / Cache             Global edge delivery

        ↓ routes by path / subdomain ↓

Section Apps — Each Independently Deployed
├── Public Site             No login · personal/family projects
├── Cam Viewer ★            Role: cam-viewer · YOU BUILD THIS
├── Dev Dashboard           Role: hs-dev · Already deployed
└── Family Services         Future · role: family

        ↓ (cam viewer fetches from here) ↓

Backend / Data — GCP project: louielabs-animal-cams
├── Cloud Run Pipeline      Gemini + YOLOv8n · tags & annotates images
├── GCS Buckets             cam-raw-uploads · cam-analyzed-captures
├── Firestore               animal_captures collection · real-time
└── Firebase Auth           Custom claims: cam-viewer, hs-dev, family
```

### The Four Roles

Everyone signs in with a @louielabs.com Google account. Access is controlled by a "role" that only the admin can set — users can never give themselves a role.

| Role | Who | Can Access | Notes |
|------|-----|------------|-------|
| *(none)* | Anyone | Public gallery — limited captures | No sign-in needed |
| `cam-viewer` | Family / friends | Full gallery, all public cameras | Read-only |
| `hs-dev` | You (students) | Gallery + Dev Dashboard | Your role during build |
| `family` | Louie family | Everything | Includes future sections |
| `admin` | Site owner | Everything + managing roles | Sets roles via script |

### What the Gallery Shows — Public vs. Private

Every captured image is tagged `public: true` or `public: false` by the processing pipeline before the website ever sees it. The gallery component just reads that tag — it never decides which images are private.

| Private reason | How it's detected | Who can see it |
|---|---|---|
| Deterrent cameras (rats/squirrels near cars) | Camera ID is flagged in config | `cam-viewer`, `hs-dev`, `family` only |
| Image contains a person | Gemini Vision detects person in frame | `cam-viewer`, `hs-dev`, `family` only |
| Image contains a dog | Gemini Vision detects dog (with confidence threshold) | `cam-viewer`, `hs-dev`, `family` only |
| Everything else | Tagged `public: true` by pipeline | Everyone including no-login visitors |

---

## 02 — What You're Building

A read-only image gallery — the camera viewer section of louielabs.com. It shows wildlife trail camera captures with animal labels, and lets visitors filter and browse.

### Features to build

- **Image card grid** — photos in a uniform grid, each card showing the image, animal label, confidence %, camera name, and relative timestamp (e.g. "3 hours ago")
- **Bounding box toggle** — a button to show or hide the detection overlay boxes drawn on each image. Hidden by default for visitors, shown by default for logged-in users
- **Filters** — filter by animal species, camera ID, and date range. Filters sit in a bar across the top
- **Lightbox** — click any image to see it full-size with the detection overlay
- **Auth-aware UI** — unauthenticated visitors see public captures only, with a "Sign in to see more" prompt. Logged-in `cam-viewer` users see everything
- **Responsive layout** — works on phone (for field use) as well as desktop

### What is already built for you

- **Firebase Auth gate** — sign-in with Google is pre-wired; you receive a user object with their role claim
- **`fetchCaptures()`** — a function you call with filter options that returns an array of CaptureCard objects (see Section 04)
- **Mock data** — 50 sample captures with varied species, cameras, timestamps, and public/private mix so you can build without waiting for the live pipeline
- **Firebase Hosting deploy** — you submit your component files; the admin handles deployment

---

## 03 — Setting Up the Repo

You'll work in a dedicated sandbox repo. You never touch auth, the database, or other sections of the site.

### Step 1 — Clone the starter repo

The admin will create the repo and invite you. Once invited, open Terminal (Mac) or PowerShell (Windows) and run:

```bash
git clone https://github.com/LouieLabs/wildwatch-cam-viewer.git
cd wildwatch-cam-viewer
npm install
npm run dev
```

You should see a local preview at **http://localhost:5173** with placeholder cards using mock data.

### Repo structure

| Folder / File | What it is |
|---|---|
| `src/components/` | **Your work lives here** — gallery, card, filters, lightbox |
| `src/api/fetchCaptures.js` | Pre-built — do not edit. Call this to get images |
| `src/api/mockData.js` | Pre-built — 50 sample captures for local development |
| `src/auth/` | Pre-built — do not edit. Handles sign-in and role checks |
| `src/App.jsx` | Entry point — import your components here |
| `tailwind.config.js` | Tailwind setup — you can add custom colors here |
| `firebase.json` | Pre-built — do not edit. Deployment config |

---

## 04 — The Data You're Working With

Every image the gallery displays is a **CaptureCard** object. You get an array of these by calling `fetchCaptures()`. The AI tools you use need to know this shape — paste it into your prompts.

### The CaptureCard object

| Field | Type | What it means |
|---|---|---|
| `id` | `string` | Unique ID for this capture |
| `imageUrl` | `string` | Full URL to the analyzed JPEG in Google Cloud Storage — use directly in `<img src>` |
| `timestamp` | `string` | ISO date string — format as "3 hours ago" or "Jun 14, 6:23 AM" |
| `cameraId` | `string` | Camera identifier e.g. `"cam-north-gate"`, `"cam-driveway"` |
| `species` | `string` | Primary animal label e.g. `"deer"`, `"raccoon"`, `"squirrel"` |
| `confidence` | `number` | 0 to 1 — show as percentage e.g. `0.91` → `"91%"` |
| `temperatureF` | `number` | Air temperature at capture time, in °F (integer). May be `null` if unknown |
| `humidityPercent` | `number` | Relative humidity at capture time, 0–100 (integer). May be `null` if unknown |
| `public` | `boolean` | `true` = visible to everyone. `false` = logged-in roles only |
| `detections` | `array` | All detected objects in frame — see sub-fields below |
| `detections[].label` | `string` | Object label e.g. `"deer"`, `"person"` |
| `detections[].confidence` | `number` | 0 to 1 confidence for this detection |
| `detections[].bbox.x` | `number` | Left edge of bounding box in pixels (original image resolution) |
| `detections[].bbox.y` | `number` | Top edge of bounding box in pixels |
| `detections[].bbox.w` | `number` | Width of bounding box in pixels |
| `detections[].bbox.h` | `number` | Height of bounding box in pixels |

> **⚠️ Bounding box scaling:** The `bbox` coordinates are in the original image's pixel dimensions. When you display the image at a smaller size, you must scale the boxes proportionally. If the original image is 1920×1080 and you display it at 480×270 (¼ size), multiply every bbox value by 0.25. Ask Claude to generate this math for you.

> **Where do `temperatureF` and `humidityPercent` come from?** For now, the values are looked up at capture time from the nearest city's current weather (using rough GPS derived from the camera's Wi-Fi, or set by the admin if Wi-Fi geo isn't usable). Once a temperature/humidity sensor is added to the camera boards, the on-board reading replaces the city lookup. The field names and units stay the same either way — the gallery doesn't need to know which source. Either field may be `null` if no reading was available.

### How to call `fetchCaptures()`

```js
import { fetchCaptures } from '../api/fetchCaptures';

const captures = await fetchCaptures({
  species:   'deer',                    // filter by animal — omit for all
  cameraId:  'cam-north-gate',          // filter by camera — omit for all
  after:     '2025-10-01T00:00:00Z',   // date range start
  before:    '2025-10-31T23:59:59Z',   // date range end
  publicOnly: true,                     // true for unauthenticated users
  limit:     50                         // max results
});
```

---

## 05 — Design Tools and How to Use Them

You'll use two AI tools. **Google Stitch** designs what the gallery looks like. **Claude** turns that design into working React code and wires it to real data.

### Tool 1 — Google Stitch (visual design)

**[stitch.withgoogle.com](https://stitch.withgoogle.com)** · Free · Sign in with any Google account · No install needed

**What it does:** You describe what you want in plain English and Stitch generates a high-fidelity UI design with Tailwind CSS code you can export. It's for figuring out how things look — colors, card layout, typography, spacing — before writing any real code.

**Step by step:**

1. Go to [stitch.withgoogle.com](https://stitch.withgoogle.com) and sign in with Google
2. Click "New project"
3. Paste the Stitch prompt from Section 06
4. Click Generate — it takes about 90 seconds
5. Review the result. If something looks wrong, type a follow-up like "make the cards larger" or "use a dark background" and hit Generate again
6. When happy with the look, click the code icon (`< >`) and copy the HTML + Tailwind CSS
7. Paste that code into a new Claude conversation along with the prompt in Section 07

> **Tip:** Stitch works best when you describe the *visual feel*, not just the components. Say "feels like a nature journal with earthy tones" not just "grid of image cards".

### Tool 2 — Claude (code + wiring)

**[claude.ai](https://claude.ai)** · Sign in with our Louie Labs account (claude@louielabs.com) · No install needed

**What it does:** Claude takes the Stitch HTML/Tailwind output and converts it into real React components connected to your `fetchCaptures()` data. It also handles the bounding box overlay math, the filter logic, the lightbox, and auth-aware rendering.

> **About the shared Project.** When you sign in with the Louie Labs account and open **Wildlife Cam Viewer** → **New chat**, you're already inside a Project that knows the stack and the data. The admin has set custom instructions (React + Tailwind, `.jsx` files, no TypeScript, match the `CaptureCard` shape, stay inside `src/components/`, and several more) and uploaded three knowledge files: this guide, `mockData.js`, and `fetchCaptures.js`. So you don't have to paste any of that yourself — each chat just needs the *new* information (your Stitch design, or the bug you're stuck on).
>
> **Everyone's chats are visible to everyone else.** Give yours a descriptive title ("gallery 3-col layout", not "untitled"), and don't delete failed attempts — that's how the rest of the class learns from each other.

**Step by step:**

1. Sign in to [claude.ai](https://claude.ai) (or the Claude Mac/Windows desktop app) with the Louie Labs account, then open **Projects → Wildlife Cam Viewer → New chat**.
2. Paste the short trigger prompt from Section 07, then paste your Stitch HTML/Tailwind below it.
3. Claude will output React component code — copy each file it produces.
4. Paste each file into the matching path under `src/components/`.
5. Run `npm run dev` and check the result in your browser at `localhost:5173`.
6. If something looks wrong or breaks, describe the issue back to Claude **in the same chat** (paste any browser-console errors too) — it remembers the code it just gave you and can fix it in place.

> **Which AI is best for the code step?** Use Claude, not Stitch. Stitch is design-only — it generates HTML mockups, not working React apps. Claude is specifically strong at converting designs into real component code, handling logic like bounding box scaling, and understanding exactly how `fetchCaptures()` should connect to the UI.

---

## 06 — Prompt for Google Stitch

Copy and paste this entire block into Stitch verbatim:

---

```
Design a wildlife trail camera image gallery web page for a family nature
monitoring project called WildWatch.

Visual feel: feels like a nature field journal — earthy, calm, not a social
app. Muted greens, warm off-white background, clean sans-serif type.
Professional but approachable. Works for adults and teenagers.

Design these specific sections:

1. PAGE HEADER — "WildWatch" logo/title on the left, a "Sign in" button on
the right. A subtle tagline under the title like "Live from the backyard
cameras."

2. FILTER BAR — A horizontal bar with three filters: Animal (dropdown with
options: All Animals, Deer, Raccoon, Squirrel, Fox, Coyote, Bird, Other),
Camera (dropdown), Date range (start and end date pickers). A "Show bounding
boxes" toggle switch on the right side of the bar.

3. IMAGE GRID — A responsive grid of image cards, 3 columns on desktop, 2 on
tablet, 1 on mobile. Each card shows: a square or slightly landscape photo, an
animal label badge in the top-left corner of the photo (e.g. "Deer"), a
confidence percentage in the top-right corner (e.g. "91%"), camera name and
relative timestamp below the photo (e.g. "North Gate · 3 hours ago").

4. EMPTY STATE — A friendly message with a small icon for when no images match
the filters. Something like "No captures found for these filters."

5. LOADING STATE — A skeleton card grid (placeholder shimmer boxes) shown
while images are loading.

Design constraints:
- Mobile-first and fully responsive
- No login form on this screen (auth is handled separately)
- Earthy, natural color palette — avoid bright blues, pinks, or neon
- Clean and readable — this will be used in daylight and at night in the field
```

---

## 07 — Prompt for Claude

Inside the **Wildlife Cam Viewer** project (Section 05), every chat already knows the stack, the rules, and the data shapes. So the per-chat prompt is short — you only bring the *new* information.

In a new chat, paste this trigger prompt, then your Stitch HTML/Tailwind below it:

---

```
Here's my Stitch design (HTML + Tailwind below). Convert it into the four
React components for the WildWatch gallery, following the project rules and
the CaptureCard shape from the uploaded guide. Match the visual style of the
design as closely as you can.

[PASTE YOUR STITCH HTML/TAILWIND HERE]
```

---

That's all you paste. The Project's custom instructions and uploaded files (this guide, `mockData.js`, `fetchCaptures.js`) already cover which components to build, the exact data shape, the bbox scaling math, and the file-output format.

### Iterating in the same chat

- **Small tweaks** ("make the cards smaller", "the bbox is off by 20px on the right") — just say so in the same chat. Claude remembers the code it just wrote and can patch it in place.
- **Visual redesigns** — go back to Stitch (Section 06), generate a new design, then start a fresh Claude chat with the new HTML.
- **Broken code or errors** — paste the browser-console message into the same chat. Claude will trace it back to the code it produced and give you a targeted fix.

## 08 — Iteration Workflow

You won't get a perfect result in one pass. Here's the loop that works:

| # | Step | Detail |
|---|---|---|
| 1 | Design in Stitch | Iterate the visual look with follow-up prompts until it feels right. Aim for 2–3 rounds. |
| 2 | Export Stitch code | Click the code icon, copy all HTML + Tailwind CSS. |
| 3 | Convert in Claude | In the Wildlife Cam Viewer project, paste the §07 trigger prompt + Stitch code. Get React files back. |
| 4 | Drop in and run | Paste each file into `src/components/`, run `npm run dev`, open localhost:5173. |
| 5 | Fix what's broken | If there's an error, paste it back to Claude in the same conversation and ask for a fix. |
| 6 | Visual tweaks | For look-and-feel changes, go back to Stitch. For logic/data bugs, stay in Claude. |
| 7 | Submit a PR | `git add .` → `git commit -m "your message"` → `git push`. Open a pull request on GitHub. |

> **When to use which tool:**
> - **Stitch** = how it *looks* (colors, spacing, card shape, typography)
> - **Claude** = how it *works* (data, logic, bounding box math, filter state, auth)
>
> Layout looks wrong → Stitch. Data is wrong or something crashes → Claude.

---

## 09 — Definition of Done

Before submitting a pull request, check that all of these work:

- [ ] Grid shows mock images with animal label, confidence %, camera name, and relative timestamp on each card
- [ ] Unauthenticated view shows only `public: true` captures
- [ ] Sign in with Google works; after login, all captures (including private) appear for `hs-dev` role
- [ ] Animal species filter narrows the grid correctly
- [ ] Camera filter narrows the grid correctly
- [ ] Date range filter narrows the grid correctly
- [ ] Bounding box toggle shows/hides boxes on all cards
- [ ] Bounding boxes are visually aligned with the animals in the images (not wildly offset)
- [ ] Click a card → lightbox opens with full-size image
- [ ] Lightbox closes on backdrop click and Escape key
- [ ] Loading skeleton shows while `fetchCaptures()` is running
- [ ] Empty state shows when no images match the filters
- [ ] Layout looks correct on phone screen width (375px)
- [ ] No console errors in browser dev tools

---

## 10 — Quick Reference

### Tools

| Tool | URL | Use for |
|---|---|---|
| Google Stitch | [stitch.withgoogle.com](https://stitch.withgoogle.com) | Visual design — layout, colors, card shape |
| Claude | [claude.ai](https://claude.ai) | Code — React components, data wiring, bug fixes |
| GitHub | github.com/LouieLabs/wildwatch-cam-viewer | Version control — commit and submit your work |
| localhost:5173 | *(local only)* | Preview your changes as you build |

### Terminal commands

| Command | What it does |
|---|---|
| `npm run dev` | Start local preview at localhost:5173 |
| `git add .` | Stage all your changes |
| `git commit -m "message"` | Save a snapshot with a description |
| `git push` | Upload your commits to GitHub |
| `git pull` | Get the latest changes from GitHub |

---

> **Questions?** Paste any error messages or confusion directly into Claude (in your Wildlife Cam Viewer project chat) — explain what you expected and what you got. If something is badly broken, ask the admin before spending a long time debugging. A 5-minute conversation saves hours.
