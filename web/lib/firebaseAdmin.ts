// Server-only Firebase Admin init for our HYBRID database setup.
//
// KEYLESS: uses Application Default Credentials (ADC) -- there is no JSON key
// file anywhere. Locally this comes from
//   gcloud auth application-default login --impersonate-service-account=...
// and in production from the runtime service account.
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
// NOTE: Realtime Database is NOT accessed via firebase-admin here -- with keyless
// ADC impersonation the admin RTDB client can't get a firebase.database-scoped
// token. Use lib/rtdb.ts (REST) for all RTDB reads/writes instead.

const app: App = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL, // Realtime Database (us-central1)
      projectId: process.env.GCP_PROJECT_ID,
    });

export const adminApp = app;

// Firestore -- the wildlife_detections collection (image URLs + Gemini boxes).
// NOTE: this project uses a NAMED Firestore database, not the "(default)" one,
// so we must pass its id explicitly.
export const adminFirestore = getFirestore(
  app,
  process.env.FIRESTORE_DATABASE_ID || 'wildlife-camera-telemetry-db'
);
