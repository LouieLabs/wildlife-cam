import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  limit,
} from 'firebase/firestore';

// firestore.rules deny ALL client access. Every read or write to any document
// from a non-admin client must fail. These tests are the safety net: if anyone
// "opens up wildlife_detections for the dashboard to read directly," CI fails
// and forces them back through the server routes (which use the admin SDK).

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-louielabs',
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe('Firestore rules: client access is fully denied', () => {
  it('denies client read of wildlife_detections', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'wildlife_detections/anything')));
  });

  it('denies client write to wildlife_detections', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'wildlife_detections/x'), { fake: true }));
  });

  it('denies client read of rate_limits (the limiter must be server-only)', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'rate_limits/x__0')));
  });

  it('denies client write to rate_limits (an attacker cannot pre-bump the counter)', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'rate_limits/x__0'), { count: 0, expiresAt: new Date() }));
  });

  it('denies client list-query of any collection', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDocs(query(collection(db, 'wildlife_detections'), limit(1))));
  });

  it('denies SIGNED-IN client too (admin-only rules ignore Firebase Auth)', async () => {
    const db = env.authenticatedContext('any-uid', { email: 'student@louielabs.com' }).firestore();
    await assertFails(getDoc(doc(db, 'wildlife_detections/x')));
    await assertFails(setDoc(doc(db, 'wildlife_detections/x'), { ok: false }));
  });
});
