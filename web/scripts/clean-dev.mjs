// Purge DEV-tagged artifacts. Production data is a different prefix / env value,
// so this can never touch it.
//   npm run clean:dev            -> dry run (just counts)
//   npm run clean:dev -- --yes   -> actually delete
//
// Run with the env loaded: package.json does `node --env-file=.env.local ...`.
import { Storage } from '@google-cloud/storage';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--yes');
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET;
const PROJECT = process.env.GCP_PROJECT_ID;
const FSDB = process.env.FIRESTORE_DATABASE_ID || 'wildlife-camera-telemetry-db';

console.log(`clean:dev ${APPLY ? '*** APPLYING (deleting) ***' : '(dry run -- pass --yes to delete)'}\n`);

// 1) GCS objects under dev/
const storage = new Storage({ projectId: PROJECT });
const [files] = await storage.bucket(BUCKET).getFiles({ prefix: 'dev/' });
console.log(`GCS  gs://${BUCKET}/dev/            : ${files.length} object(s)`);
if (APPLY && files.length) {
  await Promise.all(files.map((f) => f.delete()));
  console.log(`     -> deleted ${files.length}`);
}

// 2) Firestore detections tagged env=="dev"
const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const fs = getFirestore(app, FSDB);
const snap = await fs.collection('wildlife_detections').where('env', '==', 'dev').get();
console.log(`Firestore wildlife_detections env=dev : ${snap.size} doc(s)`);
if (APPLY && snap.size) {
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = fs.batch();
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  console.log(`     -> deleted ${snap.size}`);
}

console.log(`\ndone${APPLY ? '' : '  (nothing deleted -- dry run)'}`);
process.exit(0);
