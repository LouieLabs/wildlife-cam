// Server-side guard for protected API routes.
//
// Verifies the Firebase ID token sent as "Authorization: Bearer <token>" and
// rejects anyone whose email is not a VERIFIED @louielabs.com address. This is
// what replaces the old (spoofable) "trust the email From header" check: the
// browser proves who the user is with a real Google sign-in, and we verify that
// proof here on the server.
import { getAuth } from 'firebase-admin/auth';
import { adminApp } from './firebaseAdmin';

const ALLOWED_DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN || 'louielabs.com';

export type LouieUser = { uid: string; email: string };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireLouieLabsUser(req: Request): Promise<LouieUser> {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Missing sign-in token');

  const decoded = await getAuth(adminApp).verifyIdToken(token);
  const email = (decoded.email || '').toLowerCase();

  if (!decoded.email_verified) throw new HttpError(403, 'Email not verified');
  if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
    throw new HttpError(403, 'Not a Louie Labs account');
  }

  return { uid: decoded.uid, email };
}
