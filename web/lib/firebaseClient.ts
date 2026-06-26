'use client';
// Client-side Firebase (runs in the browser). These NEXT_PUBLIC_* values are
// NOT secrets -- Firebase web config is designed to be public. The real
// protection is in the server routes (requireLouieLabsUser) and the database
// rules (firebase-rules.json).
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
};

export const clientApp = getApps().length ? getApp() : initializeApp(config);
export const clientAuth = getAuth(clientApp);

export const googleProvider = new GoogleAuthProvider();
// Hint Google to show only Louie Labs accounts. This is just a nicety -- the
// real domain check is enforced on the server.
googleProvider.setCustomParameters({
  hd: process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN || 'louielabs.com',
});
