import { clientAuth } from '@/lib/firebaseClient';

// fetch() wrapper that attaches the signed-in Louie Labs user's Firebase ID
// token as a Bearer header -- the same auth the dashboard's admin API routes
// (requireLouieLabsUser) expect. Shared by the dashboard and the image pages.
// Throws if called while signed out, so callers should only fetch once a user
// is present (see useUser()).
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const user = clientAuth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  return fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}
