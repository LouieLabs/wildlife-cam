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

    // Union of "anything device_meta knows about" + "anything that has ever
    // reported telemetry" -- so a newly-renamed entry (meta but no devices
    // node yet) AND any legacy device with telemetry but no meta both show up.
    const allIds = new Set<string>([...Object.keys(meta), ...Object.keys(devices)]);

    const list = Array.from(allIds).map((id) => {
      const node = devices[id] || {};
      const state = node.state || {};
      const m = meta[id] || {};
      const isTombstone = m.status === 'renamed';
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
        // Rename audit trail. metaStatus is 'renamed' for tombstones, null otherwise.
        // The dashboard groups by this + checks the renamedTo entry's last
        // check-in to decide active-pending vs fully-archived.
        metaStatus: isTombstone ? 'renamed' : null,
        renamedTo:  typeof m.renamedTo  === 'string' ? m.renamedTo  : null,
        renamedAt:  typeof m.renamedAt  === 'number' ? m.renamedAt  : null,
        previousId: typeof m.previousId === 'string' ? m.previousId : null,
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
