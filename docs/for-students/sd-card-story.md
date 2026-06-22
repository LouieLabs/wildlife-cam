# The Memory-Card Mystery (a true debugging story)

This is the real story of getting the camera to save a file to its memory card.
It *looked* like a 10-minute job. It took about 4 hours. The point of this writeup
isn't the wiring — it's **how engineers corner a problem when something "just
won't work."** That skill transfers to any field.

## The goal

Make the board write a tiny file to the microSD card and read it back. If that
works, the camera can save photos.

## What kept happening

The board kept printing **"WRONG FORMAT"** — as if the memory card was set up
incorrectly. So the obvious move was: reformat the card. We reformatted it several
different ways. It *still* said WRONG FORMAT. That's the first lesson:

> **Lesson 1 — the error message is a *clue*, not the *answer*.** "WRONG FORMAT"
> was the board's best guess, but it was wrong about the real cause.

## Checking the assumption

Instead of trusting the message, we **checked the card directly** on a Mac. The
card was formatted perfectly fine. We even read the card's raw "table of contents"
and confirmed it was correct, byte for byte.

> **Lesson 2 — verify the thing you're blaming.** We almost spent the whole day
> reformatting a card that was never broken.

## Changing one thing at a time

So if the card was fine, what was different? We tested combinations **one variable
at a time**:
- a different memory card → still failed
- a different identical board → worked sometimes, not always
- plugged straight into the laptop instead of through a hub → more stable
- a fresh card → worked

That "works sometimes" pattern is a huge hint: a *solid* bug fails every time; an
*intermittent* one points to a shaky physical connection or power.

> **Lesson 3 — change ONE thing per test.** If you change three things at once and
> it works, you don't know which one mattered.

## The real causes (two of them, hiding together)

1. **A flaky card slot** on one of the boards — a loose physical connection.
2. **A "frozen card."** Once the card got confused, it stayed stuck. Pressing the
   reset button did **not** fix it — only fully unplugging the USB for a few
   seconds did. (Reset restarts the brain but leaves the card powered and still
   confused; a full power-off is like force-restarting a frozen phone.)

A lot of the "still broken!" moments were actually us re-testing a *frozen* card
without ever fully cutting its power.

> **Lesson 4 — know the difference between "restart" and "full power-off."** They
> are not the same, and sometimes only the big one works.

## How we proved it

We had the board print the *exact* internal error code instead of the vague
"WRONG FORMAT." That told us the truth: the card wasn't even waking up — a
connection/power problem, not a formatting problem. With a good card, a good
board, and a real power-cycle, it mounted instantly and saved the file.

> **Lesson 5 — get a better signal.** When a message is vague, make the system
> tell you *more*. A precise clue beats hours of guessing.

## The takeaway (works in any subject)

1. Treat error messages as clues, not verdicts.
2. Verify the thing you're about to blame.
3. Change one variable at a time, and keep notes.
4. "Intermittent" = suspect physical/power, not logic.
5. When stuck, make the system give you a clearer signal.

That loop — **guess → test one thing → read the clue → repeat** — is how real
debugging works, whether it's a circuit, a chemistry experiment, or an essay.
