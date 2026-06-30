import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet, rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import {
  type SavedNetwork,
  slugify,
  validatePassword,
} from '@/lib/networks';

export const runtime = 'nodejs';

// Defense-in-depth: this enforcing matches the slug rules in lib/networks.ts
// AND lib/rtdb.ts safePath. Lets us reject malformed inputs before hitting RTDB.
function validateSlug(slug: string): string | null {
  if (!/^[a-z0-9_-]{1,32}$/.test(slug)) return 'Invalid slug';
  return null;
}

// GET /api/networks/[slug]
// Returns the FULL record including password. Auth-gated like all the others;
// no public read path. Used by the picker (auto-fill the password input on a
// saved-network pick) and the admin "Reveal" button.
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await requireLouieLabsUser(req);
    const { slug } = await ctx.params;
    const slugErr = validateSlug(slug);
    if (slugErr) return NextResponse.json({ error: slugErr }, { status: 400 });

    const rec = await rtdbGet<SavedNetwork>(`networks/${slug}`);
    if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({ network: rec });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// PUT /api/networks/[slug]
// Update password and/or notes for an existing network. SSID is immutable
// because changing it would change the slug, which would orphan any consumer
// referencing the old slug -- delete + re-create if you really need that.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireLouieLabsUser(req);
    const { slug } = await ctx.params;
    const slugErr = validateSlug(slug);
    if (slugErr) return NextResponse.json({ error: slugErr }, { status: 400 });

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:networks-write`,
      limit: 20,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const existing = await rtdbGet<SavedNetwork>(`networks/${slug}`);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json();
    const updated: SavedNetwork = { ...existing };

    if (body.password !== undefined) {
      const pwErr = validatePassword(body.password);
      if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });
      updated.password = String(body.password);
    }
    if (body.notes !== undefined) {
      updated.notes = String(body.notes).slice(0, 200);
    }

    updated.updatedBy = user.email;
    updated.updatedAt = Date.now();
    await rtdbSet(`networks/${slug}`, updated);

    return NextResponse.json({ network: updated });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// DELETE /api/networks/[slug]
// Permanently removes the saved network. Cameras already provisioned with the
// old creds keep working -- they only consult this notebook at provision time.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireLouieLabsUser(req);
    const { slug } = await ctx.params;
    const slugErr = validateSlug(slug);
    if (slugErr) return NextResponse.json({ error: slugErr }, { status: 400 });

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:networks-write`,
      limit: 20,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const existing = await rtdbGet<SavedNetwork>(`networks/${slug}`);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Setting null is how RTDB removes a key.
    await rtdbSet(`networks/${slug}`, null);

    return NextResponse.json({ deleted: slug });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
