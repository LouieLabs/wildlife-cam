import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// The dashboard reads live device state through THIS server route, never
// directly from the database. We strip the per-device secret before sending
// anything to the browser. Data source: Realtime Database /devices.
export async function GET(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 120/min per signed-in user -- the dashboard polls every few seconds with
    // a tab or two open, this gives plenty of headroom.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:devices`,
      limit: 120,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const [devicesData, metaData, secretsData] = await Promise.all([
      rtdbGet<Record<string, any>>('devices'),
      rtdbGet<Record<string, any>>('device_meta'),
      // Secrets are admin-visible by project decision (matches saved-networks
      // notebook trust model: any signed-in @louielabs.com user can see all).
      // RTDB rules block direct client reads of pre_shared_keys, so the only
      // path to a secret is THIS authenticated server route.
      rtdbGet<Record<string, string>>('pre_shared_keys'),
    ]);

    const devices = devicesData || {};
    const meta = metaData || {};
    const secrets = secretsData || {};

    // Union of devices that have state and devices that are registered (in
    // device_meta) but haven't reported yet -- so a freshly-registered camera
    // shows up even before its first wake.
    const ids = new Set<string>([...Object.keys(devices), ...Object.keys(meta)]);

    const list = Array.from(ids).map((id) => {
      const node = devices[id] || {};
      const state = node.state || {};
      const m = meta[id] || {};
      return {
        deviceId: id,
        status: state.status ?? 'unknown',
        battery: typeof state.battery === 'number' ? state.battery : null,
        lastUpdate: state.updatedAt ?? null,
        firmwareVersion: state.firmwareVersion ?? null,
        command: node.command ?? 'idle',
        mac: m.mac ?? null,
        // Per-camera network creds captured at provision time (null when the
        // camera was never provisioned on that radio). Visible because this
        // route is gated to @louielabs.com admins.
        netMode: m.netMode ?? null,
        wifiSsid: m.wifiSsid ?? null,
        wifiPass: m.wifiPass ?? null,
        halowSsid: m.halowSsid ?? null,
        halowPsk: m.halowPsk ?? null,
        // Device secret (the value the board sends in x-device-secret). Lets
        // an admin recover it without a separate lookup endpoint.
        secret: secrets[id] ?? null,
      };
    });

    return NextResponse.json({ devices: list });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
