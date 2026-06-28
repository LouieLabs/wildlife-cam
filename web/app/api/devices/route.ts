import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// The dashboard reads live device state through THIS server route, never
// directly from the database. We strip the per-device secret before sending
// anything to the browser. Data source: Realtime Database /devices.
export async function GET(req: NextRequest) {
  try {
    await requireLouieLabsUser(req);

    const [devicesData, metaData] = await Promise.all([
      rtdbGet<Record<string, any>>('devices'),
      rtdbGet<Record<string, any>>('device_meta'),
    ]);

    const devices = devicesData || {};
    const meta = metaData || {};

    const list = Object.keys(devices).map((id) => {
      const node = devices[id] || {};
      const state = node.state || {};
      const m = meta[id] || {};
      return {
        deviceId: id,
        status: state.status ?? 'unknown',
        battery: typeof state.battery === 'number' ? state.battery : null,
        lastUpdate: state.updatedAt ?? null,
        command: node.command ?? 'idle',
        mac: m.mac ?? null,
        // Expected-network metadata for debugging ("expects Aloha, last seen
        // 2h ago"). SSIDs only -- passwords are never stored on the server.
        wifiSsid:  typeof m.wifiSsid  === 'string' ? m.wifiSsid  : null,
        halowSsid: typeof m.halowSsid === 'string' ? m.halowSsid : null,
        netMode:   typeof m.netMode   === 'string' ? m.netMode   : null,
        // NOTE: state.secret is intentionally NOT included in the response.
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
