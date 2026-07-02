import { NextRequest, NextResponse } from 'next/server';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// GET /api/firmware/builds
//
// Returns the list of firmware .bin files Slice C's Cloud Build has staged
// under web/public/firmware/builds/<boardType>/<sha>/firmware.bin. The
// firmware-publish dashboard consumes this to populate its build picker,
// filtered by the board type of the cameras the admin is targeting.
//
// Data source: the filesystem inside the Cloud Run container. Cheap enough
// for our fleet size (< 100 builds at any time) that a per-request scan is
// fine; no need for a cache or a metadata index yet.
//
// Response:
//   {
//     builds: [
//       { boardType: "heltec-ht-hc33", sha: "a1b2c3d",
//         sizeBytes: 1187072, mtime: 1719878400000 }
//     ]
//   }
//
// Result is empty (not an error) when no builds exist yet -- a fresh clone
// running locally before any Cloud Build has fired sees builds: []. The
// firmware-publish UI treats that as "publish another build first."
// ---------------------------------------------------------------------------

// Guardrails: only accept path segments that could plausibly have come from
// our own conventions. Anything else means someone dropped a file into public/
// that shouldn't be there; skip silently rather than expose it.
const BOARD_RE = /^[a-z0-9-]{3,64}$/;
const SHA_RE   = /^[a-f0-9]{7,64}$/;

export async function GET(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 60/min per admin -- dashboard reloads this every few seconds while the
    // firmware-publish page is open. Same order-of-magnitude as /api/devices.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:firmware-builds`,
      limit: 60,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: rateLimitHeaders(rl) }
      );
    }

    const buildsRoot = join(process.cwd(), 'public', 'firmware', 'builds');

    // Level 1: board type directories
    let boards: string[] = [];
    try {
      boards = await readdir(buildsRoot);
    } catch {
      // No builds/ directory yet -- normal for a fresh install or before the
      // first Cloud Build has run. Return an empty list rather than 500.
      return NextResponse.json({ builds: [] });
    }

    const results: Array<{
      boardType: string;
      sha: string;
      sizeBytes: number;
      mtime: number;
    }> = [];

    for (const boardType of boards) {
      if (!BOARD_RE.test(boardType)) continue;
      const boardDir = join(buildsRoot, boardType);
      let shas: string[] = [];
      try {
        shas = await readdir(boardDir);
      } catch {
        continue;
      }
      for (const sha of shas) {
        if (!SHA_RE.test(sha)) continue;
        const binPath = join(boardDir, sha, 'firmware.bin');
        try {
          const s = await stat(binPath);
          if (!s.isFile() || s.size <= 0) continue;
          results.push({
            boardType,
            sha,
            sizeBytes: s.size,
            mtime: Math.floor(s.mtimeMs),
          });
        } catch {
          // Missing firmware.bin under a sha dir means the compile step
          // didn't finish or the dir was hand-created; skip silently.
        }
      }
    }

    // Newest first: admins usually want the latest build at the top.
    results.sort((a, b) => b.mtime - a.mtime);

    return NextResponse.json({ builds: results });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
