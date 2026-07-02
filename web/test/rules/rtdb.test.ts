import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
// Modular Realtime Database SDK (firebase v9+ surface).
import { ref, get, set } from 'firebase/database';

// These tests run against the Firebase RTDB emulator (booted by
// `firebase emulators:exec` via `npm run test:rules`). They exercise the
// committed firebase-rules.json against simulated CLIENT requests (NOT the
// admin SDK — admin bypasses rules). The point is to catch rule drift before
// it ships: a typo that opens /pre_shared_keys to the world would otherwise
// only be spotted by an attacker.

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-louielabs',
    database: {
      rules: readFileSync(resolve(__dirname, '../../firebase-rules.json'), 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearDatabase();
});

describe('RTDB rules: secret-protected paths', () => {
  it('denies reads from /pre_shared_keys (server-only, holds device secrets)', async () => {
    // Privileged seed so we KNOW there's data to (fail to) read.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'pre_shared_keys/cam_a'), 'SECRET-X');
    });
    const db = env.unauthenticatedContext().database();
    await assertFails(get(ref(db, 'pre_shared_keys/cam_a')));
  });

  it('denies writes to /pre_shared_keys (only the server admin SDK should mint these)', async () => {
    const db = env.unauthenticatedContext().database();
    await assertFails(set(ref(db, 'pre_shared_keys/cam_a'), 'attacker-set-key'));
  });

  it('denies reads + writes on /device_meta (registry metadata is server-only)', async () => {
    const db = env.unauthenticatedContext().database();
    await assertFails(get(ref(db, 'device_meta/cam_a')));
    await assertFails(set(ref(db, 'device_meta/cam_a'), { mac: 'AABBCCDDEEFF' }));
  });

  it('denies reads + writes on /networks (the saved-WiFi notebook is admin-only)', async () => {
    // Seed an entry under privileged context so we KNOW there's data to fail to read.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'networks/aloha'), {
        slug: 'aloha', ssid: 'Aloha', password: 'Honolulu',
        createdBy: 't@x', createdAt: 1, updatedBy: 't@x', updatedAt: 1,
      });
    });
    const db = env.unauthenticatedContext().database();
    await assertFails(get(ref(db, 'networks/aloha')));
    await assertFails(set(ref(db, 'networks/aloha'), { password: 'attacker' }));
  });
});

describe('RTDB rules: /devices/{id}/state -- secret-gated client write', () => {
  it('accepts a state write when the secret matches the registry', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'pre_shared_keys/cam_a'), 'RIGHT-SECRET');
    });
    const db = env.unauthenticatedContext().database();
    await assertSucceeds(set(ref(db, 'devices/cam_a/state'), {
      status: 'online',
      battery: 87,
      secret: 'RIGHT-SECRET',
      updatedAt: Date.now(),
    }));
  });

  it('rejects a state write when the secret is wrong', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'pre_shared_keys/cam_a'), 'RIGHT-SECRET');
    });
    const db = env.unauthenticatedContext().database();
    await assertFails(set(ref(db, 'devices/cam_a/state'), {
      status: 'online',
      battery: 87,
      secret: 'WRONG-SECRET',
      updatedAt: Date.now(),
    }));
  });

  it('rejects a state write when /pre_shared_keys has no entry for that device', async () => {
    const db = env.unauthenticatedContext().database();
    await assertFails(set(ref(db, 'devices/ghost_cam/state'), {
      status: 'online',
      secret: 'anything',
      updatedAt: Date.now(),
    }));
  });
});

describe('RTDB rules: /devices/{id}/command -- server-only', () => {
  it('denies client writes (commands must come from /api/command, never directly)', async () => {
    const db = env.unauthenticatedContext().database();
    await assertFails(set(ref(db, 'devices/cam_a/command'), 'take_picture'));
  });

  it('denies client reads (cameras poll via /api/command-poll instead)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'devices/cam_a/command'), 'idle');
    });
    const db = env.unauthenticatedContext().database();
    await assertFails(get(ref(db, 'devices/cam_a/command')));
  });
});

describe('RTDB rules: /devices/{id}/otaTarget -- server-only (Slice B)', () => {
  // Guaranteed-brick guard: if a client could forge otaTarget, they'd
  // instruct a real camera to download whatever URL they specified. The path
  // MUST be admin-server-only.

  it('denies client writes (only /api/firmware/publish should ever write this)', async () => {
    // Even a legitimate-looking payload should be refused -- the /api that
    // owns this write is the ONLY one that computes SHA256 from the actual
    // .bin, so any client-written otaTarget is by definition untrusted.
    const db = env.unauthenticatedContext().database();
    await assertFails(set(ref(db, 'devices/cam_a/otaTarget'), {
      url: 'https://attacker.example/backdoor.bin',
      sha256: 'a'.repeat(64),
      sizeBytes: 1234,
      version: 'a1b2c3d',
      boardType: 'heltec-ht-hc33',
      expectedSeconds: 30,
      minBytesPerSec: 20000,
      maxSeconds: 90,
    }));
  });

  it('denies client reads (cameras receive otaTarget via /api/command-poll, not a direct RTDB read)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'devices/cam_a/otaTarget'), {
        url: 'https://ex.com/x.bin', sha256: 'abc', sizeBytes: 1,
      });
    });
    const db = env.unauthenticatedContext().database();
    await assertFails(get(ref(db, 'devices/cam_a/otaTarget')));
  });
});

describe('RTDB rules: state extension for OTA fields (Slice B regression)', () => {
  // Sanity-check that adding fwVersion / boardType / lastOta to the state
  // payload still passes the same secret-gated .write rule; no rule change
  // needed here, but a rule tweak upstream must not break this shape.

  it('accepts a state write that ALSO carries fwVersion, boardType, and lastOta', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'pre_shared_keys/cam_a'), 'RIGHT-SECRET');
    });
    const db = env.unauthenticatedContext().database();
    await assertSucceeds(set(ref(db, 'devices/cam_a/state'), {
      status: 'online',
      battery: 87,
      secret: 'RIGHT-SECRET',
      firmwareVersion: 'a1b2c3d (Jul  1 2026 12:34:56)',
      boardType: 'heltec-ht-hc33',
      updatedAt: Date.now(),
      lastOta: {
        result: 'Ok',
        from: 'oldsha',
        to: 'a1b2c3d',
        durationS: 12,
        ts: Date.now(),
      },
    }));
  });
});
