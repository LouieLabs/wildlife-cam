import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rtdbGet, rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// POST /api/firmware/publish
//
// In plain words: a signed-in Louie Labs admin picks a compiled firmware
// build and a list of cameras, and this route tells each camera to update to
// that build. The .bin file itself must already exist under
// public/firmware/builds/<boardType>/<buildSha>/firmware.bin (Cloud Build
// publishes it there in Slice C).
//
// Body:
//   {
//     "deviceIds":  ["cam_a", "cam_b"],
//     "buildSha":   "a1b2c3d",
//     "boardType":  "heltec-ht-hc33"
//   }
//
// What this route does, gating outward from the safest defense:
//   1. Requires a Louie Labs sign-in (401 otherwise)
//   2. Rate limits per user (10/min -- enough for a rollout wave, blocks a
//      loop)
//   3. Validates the body shape and character sets
//   4. Checks the .bin exists at
//        public/firmware/builds/<boardType>/<buildSha>/firmware.bin
//      Refuses the whole request if not (404) -- no per-device weirdness
//   5. Computes SHA256 of the .bin ONCE, embeds it into the otaTarget so the
//      device verifies against the true file (an admin can't hand-supply a
//      wrong hash by accident)
//   6. For each deviceId:
//        - Reads /devices/<id>/state/boardType from RTDB
//        - If missing OR != body.boardType, records the failure and skips
//          (guaranteed brick if we let a Heltec .bin go to a Lilygo)
//        - Otherwise writes /devices/<id>/otaTarget and
//          /devices/<id>/command = "update_firmware"
//   7. Returns per-device results so the dashboard shows exactly which
//      cameras will pick up the OTA on their next timer wake and which
//      were rejected
//
// See docs/FLASH_STORAGE_OTA_PLAN.md (Step 3, Issue 9A) for why the
// board-type gate lives at three layers -- this is the middle one.
// ---------------------------------------------------------------------------

// Guardrails on the wire format. Match the firmware's parser (Slice A) --
// changes here need matching parser changes there.
const DEVICE_ID_RE  = /^[A-Za-z0-9_-]{3,40}$/;
const BUILD_SHA_RE  = /^[a-f0-9]{7,64}$/;
const BOARD_TYPE_RE = /^[a-z0-9-]{3,64}$/;
const MAX_DEVICES_PER_CALL = 50;

// Server-picked budgets for the stall detector (Issue 19A). These are
// conservative 2.4 GHz numbers; HaLow verification lands via TODOS.md item 2.
function computeStallBudgets(sizeBytes: number) {
  const expectedSeconds = Math.max(10, Math.ceil(sizeBytes / 40_000));
  const maxSeconds      = Math.min(120, expectedSeconds * 3);
  const minBytesPerSec  = 20_000;
  return { expectedSeconds, minBytesPerSec, maxSeconds };
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:firmware-publish`,
      limit: 10,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: rateLimitHeaders(rl) }
      );
    }

    const body = await req.json().catch(() => ({}));
    const deviceIds: unknown = body.deviceIds;
    const buildSha  = String(body.buildSha ?? '').toLowerCase().trim();
    const boardType = String(body.boardType ?? '').toLowerCase().trim();

    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      return NextResponse.json({ error: 'deviceIds must be a non-empty array' }, { status: 400 });
    }
    if (deviceIds.length > MAX_DEVICES_PER_CALL) {
      return NextResponse.json(
        { error: `deviceIds must have at most ${MAX_DEVICES_PER_CALL} entries` },
        { status: 400 }
      );
    }
    // Every ID individually valid; reject the whole call if any is malformed,
    // so an accidental typo doesn't split a rollout across "worked" + "wrong".
    for (const raw of deviceIds) {
      const id = String(raw);
      if (!DEVICE_ID_RE.test(id)) {
        return NextResponse.json(
          { error: `Invalid device ID: ${JSON.stringify(id)}` },
          { status: 400 }
        );
      }
    }
    if (!BUILD_SHA_RE.test(buildSha)) {
      return NextResponse.json(
        { error: 'buildSha must be 7-64 lowercase hex chars' },
        { status: 400 }
      );
    }
    if (!BOARD_TYPE_RE.test(boardType)) {
      return NextResponse.json(
        { error: 'boardType must be 3-64 chars of [a-z0-9-]' },
        { status: 400 }
      );
    }

    // Build path is content-addressed: Cloud Build (Slice C) writes each
    // compiled .bin under public/firmware/builds/<boardType>/<sha>/. Anything
    // else points at either a build that hasn't landed yet or (much worse) a
    // typo'd sha that would 404 the field devices on download.
    const binPath = join(process.cwd(), 'public', 'firmware', 'builds', boardType, buildSha, 'firmware.bin');
    let sizeBytes = 0;
    try {
      const s = await stat(binPath);
      if (!s.isFile()) throw new Error('not a file');
      sizeBytes = s.size;
    } catch {
      return NextResponse.json(
        { error: `Build not found: builds/${boardType}/${buildSha}/firmware.bin` },
        { status: 404 }
      );
    }
    if (sizeBytes <= 0) {
      return NextResponse.json({ error: 'Build file is empty' }, { status: 500 });
    }

    // Hash the .bin ONCE per request. Field-device SHA256 verify (Slice A's
    // otaDownloadAndFlash) compares against this value; the admin cannot
    // hand-supply a wrong hash by accident.
    const buf = await readFile(binPath);
    const sha256 = createHash('sha256').update(buf).digest('hex');

    const { expectedSeconds, minBytesPerSec, maxSeconds } = computeStallBudgets(sizeBytes);
    const origin = new URL(req.url).origin;
    const url = `${origin}/firmware/builds/${boardType}/${buildSha}/firmware.bin`;
    const version = buildSha;   // buildSha IS the version identifier

    // Per-device: check board-type + write otaTarget + command. One failure
    // never blocks the others. Failures are recorded and returned so the
    // dashboard can highlight them.
    const published: string[] = [];
    const errors: { deviceId: string; reason: string }[] = [];

    for (const raw of deviceIds) {
      const deviceId = String(raw);
      try {
        const cameraBoardType = await rtdbGet<string>(`devices/${deviceId}/state/boardType`);
        if (!cameraBoardType) {
          errors.push({ deviceId, reason: 'Camera has not reported its boardType yet' });
          continue;
        }
        if (cameraBoardType !== boardType) {
          errors.push({
            deviceId,
            reason: `Camera boardType is ${cameraBoardType}, build is for ${boardType}`,
          });
          continue;
        }

        const otaTarget = {
          url,
          sha256,
          sizeBytes,
          version,
          boardType,
          expectedSeconds,
          minBytesPerSec,
          maxSeconds,
        };
        await rtdbSet(`devices/${deviceId}/otaTarget`, otaTarget);
        await rtdbSet(`devices/${deviceId}/command`, 'update_firmware');
        published.push(deviceId);
      } catch (err) {
        errors.push({
          deviceId,
          reason: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      buildSha,
      boardType,
      sizeBytes,
      sha256,
      published,
      errors,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
