// Server-only Firebase Admin init.
//
// KEYLESS: uses Application Default Credentials (ADC) -- there is no JSON key
// file anywhere. Locally this comes from
//   gcloud auth application-default login --impersonate-service-account=...
// and in production from the runtime service account.
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const app: App = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      projectId: process.env.GCP_PROJECT_ID,
    });

export const adminApp = app;
export const adminDb = getDatabase(app);
