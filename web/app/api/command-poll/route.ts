import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet } from '@/lib/rtdb';
import { requireDeviceSecret } from '@/lib/requireDeviceSecret';
import { HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

// Must run on the Node.js runtime: rtdbGet needs the Google Cloud SDK + ADC.
export const runtime = 'nodejs';

// The camera polls HERE for its pending command instead of reading the database
// directly. The database's `command` path is no longer world-readable, so this
// route (which reads it with admin credentials, bypassing the rules) is the only
// way in. Authenticated via the per-device secret in the x-device-secret header.
//
// Response shape:
//   { deviceId, command }                                    // most wakes
//   { deviceId, command: "update_firmware", ota: {...} }     // when otaTarget is set
//
// The `ota` object carries the exact fields the Slice A firmware parses out of
// this response (see cloud_telemetry_node/cloud_backend.cpp getCommand). If the
// command is "update_firmware" but the otaTarget is missing or malformed, we
// still return the command so the field device logs the missing payload -- the
// firmware then reports it as a malformed command and skips the update.

// Shape written by /api/firmware/publish. Kept as a type here so the ota
// object we hand to the firmware never carries extra RTDB junk (or drift from
// the publish route's expectations).
type OtaTargetV1 = {
  url: string;
  sha256: string;
  sizeBytes: number;
  version: string;
  boardType: string;
  expectedSeconds: number;
  minBytesPerSec: number;
  maxSeconds: number;
};

// Extract exactly the OtaTargetV1 fields. Any missing/wrong-type field means
// we treat the target as absent -- safer than sending the firmware a half
// payload it might misinterpret.
function sanitizeOtaTarget(raw: unknown): OtaTargetV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url       = typeof r.url === 'string'       ? r.url       : '';
  const sha256    = typeof r.sha256 === 'string'    ? r.sha256    : '';
  const version   = typeof r.version === 'string'   ? r.version   : '';
  const boardType = typeof r.boardType === 'string' ? r.boardType : '';
  const sizeBytes       = typeof r.sizeBytes === 'number'       ? r.sizeBytes       : 0;
  const expectedSeconds = typeof r.expectedSeconds === 'number' ? r.expectedSeconds : 0;
  const minBytesPerSec  = typeof r.minBytesPerSec === 'number'  ? r.minBytesPerSec  : 0;
  const maxSeconds      = typeof r.maxSeconds === 'number'      ? r.maxSeconds      : 0;
  if (!url || !sha256 || !boardType || sizeBytes <= 0) return null;
  return { url, sha256, sizeBytes, version, boardType, expectedSeconds, minBytesPerSec, maxSeconds };
}

// Shape written by PATCH /api/devices/[deviceId] (set_wifi). Handed to the
// firmware's getCommand() as the nested "wifi" object.
type WifiTargetV1 = { ssid: string; pass: string; netMode: string };

// Only hand back a well-formed target. ssid must be present; pass may be empty
// (open network); netMode defaults to 2.4 GHz Wi-Fi (the only radio the current
// firmware connects with).
function sanitizeWifiTarget(raw: unknown): WifiTargetV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ssid = typeof r.ssid === 'string' ? r.ssid : '';
  const pass = typeof r.pass === 'string' ? r.pass : '';
  let netMode = typeof r.netMode === 'string' ? r.netMode : 'wifi';
  if (netMode !== 'wifi' && netMode !== 'halow' && netMode !== 'both') netMode = 'wifi';
  if (!ssid) return null;
  return { ssid, pass, netMode };
}

// Shape written by POST /api/devices/[deviceId]/rename (set_id). Handed to the
// firmware as the nested "rename" object.
type IdTargetV1 = { newId: string };

function sanitizeIdTarget(raw: unknown): IdTargetV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const newId = typeof r.newId === 'string' ? r.newId : '';
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(newId)) return null;
  return { newId };
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:command-poll`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  let deviceId = '';
  try {
    const body = await req.json();
    deviceId = String(body.deviceId || '').trim();
  } catch {
    // fall through; requireDeviceSecret will reject the empty/invalid id
  }

  try {
    await requireDeviceSecret(req, deviceId);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const command = (await rtdbGet<string>(`devices/${deviceId}/command`)) ?? 'idle';

  if (command === 'update_firmware') {
    const target = sanitizeOtaTarget(await rtdbGet<unknown>(`devices/${deviceId}/otaTarget`));
    if (target) {
      return NextResponse.json({ deviceId, command, ota: target });
    }
    // Command says update but the payload is gone/malformed. Return the verb
    // anyway -- the firmware treats "update_firmware without ota" as a skip,
    // and the dashboard sees the missing payload from state.lastOta later.
  }

  if (command === 'set_wifi') {
    const wifi = sanitizeWifiTarget(await rtdbGet<unknown>(`devices/${deviceId}/wifiTarget`));
    if (wifi) {
      return NextResponse.json({ deviceId, command, wifi });
    }
    // Missing/malformed target -> return the verb; firmware ignores a set_wifi
    // with no wifi object rather than joining a garbage network.
  }

  if (command === 'set_id') {
    const rename = sanitizeIdTarget(await rtdbGet<unknown>(`devices/${deviceId}/idTarget`));
    if (rename) {
      return NextResponse.json({ deviceId, command, rename });
    }
    // Missing/malformed target -> return the verb; firmware ignores a set_id
    // with no rename object rather than adopting a garbage id.
  }

  return NextResponse.json({ deviceId, command });
}
