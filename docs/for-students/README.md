# Wildlife Cam — Start Here (plain-English guide)

New to this project? Read this first. No computer-science, mechanical, or
electrical background needed — we explain things with everyday comparisons.

## What we're building

A small **wildlife camera** you can put outside. It takes pictures/video of
animals, and it can either **show you a live view** in your browser or **save
the photos and check in with a website** so you can see them later. The whole
thing runs on a tiny computer the size of a stick of gum.

## Two modes — pick one for your board

A single board runs **either** of these — not both at once.

| | **A. Live-stream camera** | **B. Cloud fleet camera** |
|---|---|---|
| What you see | A live video feed in your browser | A website listing your camera(s) + the photos they took |
| Stays on? | Always on (plugged in) | Naps; wakes every ~30s to check in |
| Storage | None — it streams live | Saved on the board's own memory until uploaded |
| Wi-Fi setup | Edit `secrets.h` in the sketch | A "Set up a camera" page does it over USB |
| Where to start | The repo's top-level [`README.md`](../../README.md) | **[fleet-setup.md](fleet-setup.md)** (in this folder) |

If you're not sure: **start with live-stream** — it's simpler and shows you
something cool fast.

## The pieces (and what each one is, simply)

| Piece | Think of it as… |
|---|---|
| **The board** (Heltec HT-HC33) | A tiny computer + camera on one small circuit board. |
| **The camera** | The "eye" — it captures the image. |
| **Internal flash** | The board's own built-in memory — like a phone's storage. Holds the firmware *and* (in fleet mode) the saved photos. |
| **Wi-Fi HaLow** | A special long-range Wi-Fi so the camera can reach far. |
| **The firmware** | The instructions we load onto the tiny computer so it knows what to do. |
| **The USB cable** | How we load instructions and watch messages from the board. |

> **Where did the microSD card go?** We used to save photos to a removable
> memory card. We stopped because the cards turned out to be unreliable on this
> board — only 1 of 4 worked. Photos now live on the board's own built-in
> memory. The [memory-card story](sd-card-story.md) is the debugging tale of
> how we figured that out.

## How you actually work on it

1. **Write/borrow instructions** (the "firmware") in the Arduino app.
2. **Upload** them to the board over USB (like installing an app).
3. **Watch the board talk back** in the "Serial Monitor" (a text window where the
   board prints what it's doing).
4. **Save your work** to the shared online folder (the "repo") so the team has it.

## If a word confuses you

Look it up in **[glossary.md](glossary.md)** — every techy term is translated into
plain English with a comparison you already know.

## Want a real example of how engineers actually solve problems?

Read **[sd-card-story.md](sd-card-story.md)** — the true story of a memory-card
bug that took ~4 hours to crack. It shows the *mindset* (guess → test one thing →
read the clue → repeat) more than any wiring detail. That mindset works in any
field, not just this project.

## How to talk to the AI helper

- For a **big/fuzzy task**, it'll ask you ~3 quick questions first — that's on
  purpose, so it builds the *right* thing.
- For a **small/clear task**, or when you just want it done, say **"just do it"**
  or start your message with **"quick:"** and it'll skip the questions.
- It will always give you a short **"In plain words"** summary of what it did.
