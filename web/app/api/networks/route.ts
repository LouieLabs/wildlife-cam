import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet, rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import {
  type SavedNetwork,
  type SavedNetworkSummary,
  slugify,
  summarize,
  validatePassword,
  validateSsid,
} from '@/lib/networks';

export const runtime = 'nodejs';

// GET /api/networks
// Lists every saved network WITHOUT the password (so an over-broad fetch never
// leaks creds). Picker + admin index call this; password is only revealed by
// the per-slug GET below when the user explicitly asks.
export async function GET(req: NextRequest) {
  try {
    await requireLouieLabsUser(req);

    const raw = (await rtdbGet<Record<string, SavedNetwork>>('networks')) || {};
    const list: SavedNetworkSummary[] = Object.values(raw).map(summarize);
    // Stable-ish ordering: most recently updated first, so the picker surfaces
    // the network you most likely want.
    list.sort((a, b) => b.updatedAt - a.updatedAt);

    return NextResponse.json({ networks: list });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// POST /api/networks
// Creates a new saved network. Slug is derived from SSID; collision rejects
// (no silent overwrite) so an admin doesn't clobber an existing record by
// accident -- if they meant to update, they use PUT.
export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:networks-write`,
      limit: 20,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const body = await req.json();
    const ssid = String(body.ssid || '').trim();
    const password = String(body.password || '');
    const notes = body.notes ? String(body.notes).slice(0, 200) : '';

    const ssidErr = validateSsid(ssid);
    if (ssidErr) return NextResponse.json({ error: ssidErr }, { status: 400 });
    const pwErr = validatePassword(password);
    if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });

    const slug = slugify(ssid);
    const existing = await rtdbGet<SavedNetwork>(`networks/${slug}`);
    if (existing) {
      return NextResponse.json(
        { error: `A saved network with slug "${slug}" already exists. Use PUT to update.` },
        { status: 409 }
      );
    }

    const now = Date.now();
    const rec: SavedNetwork = {
      slug,
      ssid,
      password,
      notes,
      createdBy: user.email,
      createdAt: now,
      updatedBy: user.email,
      updatedAt: now,
    };
    await rtdbSet(`networks/${slug}`, rec);

    return NextResponse.json({ network: summarize(rec) }, { status: 201 });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
