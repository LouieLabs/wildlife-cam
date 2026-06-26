// Server-only Firebase Admin init for our HYBRID database setup.
//
// KEYLESS: uses Application Default Credentials (ADC) -- there is no JSON key
// file anywhere. Locally this comes from
//   gcloud auth application-default login --impersonate-service-account=...
// and in production from the runtime service account.
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';

const app: App = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL, // Realtime Database (us-central1)
      projectId: process.env.GCP_PROJECT_ID,
    });

export const adminApp = app;

// Realtime Database -- lightweight live device state + commands under /devices.
export const adminDb = getDatabase(app);

// Firestore -- the wildlife_detections collection (image URLs + Gemini boxes).
// NOTE: this project uses a NAMED Firestore database, not the "(default)" one,
// so we must pass its id explicitly.
export const adminFirestore = getFirestore(
  app,
  process.env.FIRESTORE_DATABASE_ID || 'wildlife-camera-telemetry-db'
);
