// Server-side Realtime Database access via REST with a firebase.database-scoped
// token.
//
// Why not firebase-admin's getDatabase()? With our KEYLESS setup (ADC
// impersonating the service account), the admin RTDB client can't obtain a
// firebase.database-scoped token through impersonation -- writes hang and log
// "invalid credentials". Firestore and Storage are unaffected (they use
// cloud-platform scope). Requesting the firebase.database scope explicitly via
// GoogleAuth + the RTDB REST API works cleanly, so we do that here.
import { GoogleAuth } from 'google-auth-library';

const RTDB = process.env.FIREBASE_DATABASE_URL;
const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/firebase.database',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
});

async function bearer(): Promise<string> {
  const token = await auth.getAccessToken();
  if (!token) throw new Error('could not obtain an RTDB access token');
  return token;
}

// Defense-in-depth: reject any path that isn't strictly slash-separated segments
// of [A-Za-z0-9_-]. This blocks path traversal and query/fragment injection
// (".", "?", "#", "$", "[", "]", "//", leading/trailing "/") no matter what a
// caller passes -- so safety never depends on every caller remembering to
// validate its own ids.
function safePath(path: string): string {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new Error(`unsafe RTDB path: ${JSON.stringify(path)}`);
  }
  return path;
}

// path is like "devices/pond_cam_01/command" (no leading slash, no ".json").
export async function rtdbGet<T = any>(path: string): Promise<T | null> {
  const res = await fetch(`${RTDB}/${safePath(path)}.json`, {
    headers: { Authorization: `Bearer ${await bearer()}` },
  });
  if (!res.ok) throw new Error(`RTDB GET ${path} -> ${res.status}`);
  return (await res.json()) as T | null;
}

export async function rtdbSet(path: string, value: unknown): Promise<void> {
  const res = await fetch(`${RTDB}/${safePath(path)}.json`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`RTDB PUT ${path} -> ${res.status}`);
}

// Atomic multi-path update. Keys are full paths from the database root (same
// shape as Firebase SDK's update()): each key is a path like
// "pre_shared_keys/pond_cam_01". A value of null deletes that path. Either
// every write applies or none do -- used by the rename flow so we can't end
// up with half the indexes pointing at the old name and half at the new.
export async function rtdbUpdate(updates: Record<string, unknown>): Promise<void> {
  for (const k of Object.keys(updates)) safePath(k);
  const res = await fetch(`${RTDB}/.json`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`RTDB PATCH (multi) -> ${res.status}: ${await res.text()}`);
}
