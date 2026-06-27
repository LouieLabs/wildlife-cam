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

// path is like "devices/pond_cam_01/command" (no leading slash, no ".json").
export async function rtdbGet<T = any>(path: string): Promise<T | null> {
  const res = await fetch(`${RTDB}/${path}.json`, {
    headers: { Authorization: `Bearer ${await bearer()}` },
  });
  if (!res.ok) throw new Error(`RTDB GET ${path} -> ${res.status}`);
  return (await res.json()) as T | null;
}

export async function rtdbSet(path: string, value: unknown): Promise<void> {
  const res = await fetch(`${RTDB}/${path}.json`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`RTDB PUT ${path} -> ${res.status}`);
}
