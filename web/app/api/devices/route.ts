import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// The dashboard reads live device state through THIS server route, never
// directly from the database. We strip the per-device secret before sending
// anything to the browser. Data source: Realtime Database /devices.
export async function GET(req: NextRequest) {
  try {
    await requireLouieLabsUser(req);

    const [devicesSnap, metaSnap] = await Promise.all([
      adminDb.ref('devices').get(),
      adminDb.ref('device_meta').get(),
    ]);

    const devices = devicesSnap.val() || {};
    const meta = metaSnap.val() || {};

    const list = Object.keys(devices).map((id) => {
      const node = devices[id] || {};
      const state = node.state || {};
      return {
        deviceId: id,
        status: state.status ?? 'unknown',
        battery: typeof state.battery === 'number' ? state.battery : null,
        lastUpdate: state.updatedAt ?? null,
        command: node.command ?? 'idle',
        mac: meta[id]?.mac ?? null,
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
