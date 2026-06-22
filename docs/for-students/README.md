# Wildlife Cam — Start Here (plain-English guide)

New to this project? Read this first. No computer-science, mechanical, or
electrical background needed — we explain things with everyday comparisons.

## What we're building

A small **wildlife camera** you can put outside. It takes pictures/video of
animals, can save them to a memory card, and can send a live view to your phone
or laptop over Wi-Fi. The whole thing runs on a tiny computer the size of a
stick of gum.

## The pieces (and what each one is, simply)

| Piece | Think of it as… |
|---|---|
| **The board** (Heltec HT-HC33) | A tiny computer + camera on one small circuit board. |
| **The camera** | The "eye" — it captures the image. |
| **The memory card** (microSD) | The "photo album" where pictures get saved. |
| **Wi-Fi HaLow** | A special long-range Wi-Fi so the camera can reach far. |
| **The firmware** | The instructions we load onto the tiny computer so it knows what to do. |
| **The USB cable** | How we load instructions and watch messages from the board. |

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
