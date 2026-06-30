// Saved-networks "shared notebook": admin-managed WPA/2.4 GHz credentials that
// the /provision picker pulls from instead of asking every student to retype
// (and store on their laptop) the school's Wi-Fi password.
//
// Storage: RTDB at networks/{slug}. slug = slugify(ssid) for safe path use;
// the original ssid is preserved in the record's .ssid field so the camera
// gets the exact bytes it needs to associate. Access is admin-only via the
// Admin SDK (rtdb.ts) -- nothing in this collection is ever exposed to a
// browser directly. The /api/networks routes are the only path in.

export type SavedNetwork = {
  slug: string;          // RTDB key, derived from ssid
  ssid: string;          // real SSID the radio sees (1-32 bytes)
  password: string;      // WPA passphrase (8-63 chars)
  notes?: string;        // optional context, e.g. "school cafeteria 2.4 GHz"
  createdBy: string;     // user email
  createdAt: number;     // epoch ms
  updatedBy: string;
  updatedAt: number;
};

// Public list shape -- same fields MINUS the password. Used by the picker and
// the admin index page so an over-broad GET never leaks creds; the password
// is fetched on-demand via /api/networks/[slug] when the user actually needs
// it (picker auto-fill, admin "Reveal").
export type SavedNetworkSummary = Omit<SavedNetwork, 'password'>;

export function summarize(n: SavedNetwork): SavedNetworkSummary {
  const { password, ...rest } = n;
  return rest;
}

// Slugify an SSID into something safe for RTDB paths. The slug is the storage
// key; the human-visible SSID lives in the record value. Constraint: the slug
// must match safePath() in lib/rtdb.ts -- [A-Za-z0-9_-]+. We lowercase + collapse
// any run of unsafe chars into a single hyphen, then trim leading/trailing
// hyphens. Length cap 32 keeps RTDB keys readable.
export function slugify(ssid: string): string {
  return ssid
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function validateSsid(ssid: string): string | null {
  const s = String(ssid || '');
  if (s.length < 1)  return 'SSID is required';
  if (s.length > 32) return 'SSID must be 32 characters or fewer (WPA limit)';
  if (slugify(s).length === 0) return 'SSID must contain at least one letter or digit';
  return null;
}

export function validatePassword(pw: string): string | null {
  const p = String(pw || '');
  if (p.length < 8)  return 'Password must be 8 characters or more (WPA2)';
  if (p.length > 63) return 'Password must be 63 characters or fewer (WPA2)';
  return null;
}
