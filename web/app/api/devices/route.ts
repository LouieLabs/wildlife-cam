import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// The dashboard reads through THIS server route, never directly from the
// database. The database itself is locked (no public read), and we strip the
// per-device secret before sending anything to the browser.
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
      const d = devices[id] || {};
      return {
        deviceId: id,
        status: d.status ?? 'unknown',
        battery: typeof d.battery === 'number' ? d.battery : null,
        lastUpdate: d.updatedAt ?? null,
        mac: meta[id]?.mac ?? null,
        // NOTE: d.secret is intentionally NOT included in the response.
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
