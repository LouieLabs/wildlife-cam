// Per-camera motion-burst capture settings that the dashboard can tune and the
// field firmware reads from the /api/command-poll reply (stored at RTDB
// devices/<id>/settings).
//
// IMPORTANT: these bounds and defaults MUST stay in sync with the firmware
// clamps in cloud_telemetry_node/node_config.h:
//   BURST_MS_MIN/MAX          <-> CAPTURE_BURST_MS bounds
//   BURST_SHOTS_MIN/MAX       <-> CAPTURE_BURST_MAX_SHOTS bounds
//   *_DEFAULT                 <-> CAPTURE_BURST_MS / CAPTURE_BURST_MAX_SHOTS
// The firmware clamps again on its side, so a value outside these bounds can
// never reach the camera even if this file drifts -- but keep them matched so
// the dashboard shows the user the same limits the firmware enforces.

export const BURST_MS_MIN = 500;      // fastest gap between burst photos (0.5 s)
export const BURST_MS_MAX = 30000;    // slowest gap (30 s)
export const BURST_SHOTS_MIN = 1;     // at least one photo per burst
export const BURST_SHOTS_MAX = 500;   // hard ceiling on shots per burst

export const BURST_MS_DEFAULT = 2000;   // firmware default: a photo every ~2 s
export const BURST_SHOTS_DEFAULT = 60;  // firmware default: ~2 min runaway cap

export type CaptureSettings = { burstMs?: number; burstMaxShots?: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

// Validate + clamp the pair coming FROM the dashboard form before we persist it.
// Throws a human-readable string (the route turns it into a 400) when the input
// isn't two finite numbers.
export function coerceCaptureSettings(raw: any): { burstMs: number; burstMaxShots: number } {
  const burstMs = Number(raw?.burstMs);
  const burstMaxShots = Number(raw?.burstMaxShots);
  if (!Number.isFinite(burstMs) || !Number.isFinite(burstMaxShots)) {
    throw 'burstMs and burstMaxShots must be numbers';
  }
  return {
    burstMs: clamp(burstMs, BURST_MS_MIN, BURST_MS_MAX),
    burstMaxShots: clamp(burstMaxShots, BURST_SHOTS_MIN, BURST_SHOTS_MAX),
  };
}

// Sanitize what we read back FROM RTDB before handing it to the firmware or the
// dashboard. Omits any field that isn't a valid positive number, so a missing
// field stays absent (the firmware reads 0 -> keeps its own value) rather than
// being coerced to a bogus minimum. Returns null when neither field is usable.
export function sanitizeCaptureSettings(raw: unknown): CaptureSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: CaptureSettings = {};
  if (typeof r.burstMs === 'number' && r.burstMs > 0) {
    out.burstMs = clamp(r.burstMs, BURST_MS_MIN, BURST_MS_MAX);
  }
  if (typeof r.burstMaxShots === 'number' && r.burstMaxShots > 0) {
    out.burstMaxShots = clamp(r.burstMaxShots, BURST_SHOTS_MIN, BURST_SHOTS_MAX);
  }
  return out.burstMs !== undefined || out.burstMaxShots !== undefined ? out : null;
}
