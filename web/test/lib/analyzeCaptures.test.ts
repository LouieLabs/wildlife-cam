import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  // Firestore query mock: collection().where().limit().get() -> snapshot
  const get = vi.fn().mockResolvedValue({ docs: [] });
  const limit = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ limit }));
  const collection = vi.fn(() => ({ where }));
  const download = vi.fn();
  return { get, limit, where, collection, download };
});

vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { collection: m.collection },
}));
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket() { return { file: () => ({ download: m.download }) }; }
  }
  return { Storage };
});

import {
  hasPersonOrDog,
  analyzeImage,
  analyzePendingCaptures,
} from '@/lib/analyzeCaptures';

// The analyzer never parses the image itself (SpeciesNet returns pixel boxes),
// so any buffer stands in for a photo.
function fakeJpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

// A SpeciesNet client stand-in — the injectable seam, so no network in tests.
function fakeSpeciesNet(detections: any[], modelVersion = 'test-sn') {
  return { detect: async () => ({ modelVersion, detections }) } as any;
}

// One SpeciesNet detection with sensible defaults, overridable per test.
function snDet(over: Record<string, unknown> = {}) {
  return {
    category: 'animal',
    label: 'mule deer',
    confidence: 0.9,
    box: [100, 100, 200, 150],
    boxNorm: [0.1, 0.1, 0.2, 0.15],
    ...over,
  };
}

describe('hasPersonOrDog (gallery privacy gate)', () => {
  it('blocks person/human/dog labels', () => {
    expect(hasPersonOrDog(['mule deer', 'person'])).toBe(true);
    expect(hasPersonOrDog(['domestic dog'])).toBe(true);
    expect(hasPersonOrDog(['HUMAN'])).toBe(true);
  });
  it('does not false-positive on substrings', () => {
    expect(hasPersonOrDog(['dogwood tree', 'raccoon'])).toBe(false);
  });
});

describe('analyzeImage (SpeciesNet only)', () => {
  it('names the species and draws a box', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ label: 'raccoon', confidence: 0.82 })]),
    });
    expect(res.analyzedBy).toBe('speciesnet');
    expect(res.detections).toEqual([{ label: 'raccoon', confidence: 0.82, box: [100, 100, 200, 150] }]);
    expect(res.boxes).toEqual([{ class: 'animal', bbox: [100, 100, 200, 150] }]);
    expect(res.isPublic).toBe(true);
  });

  it('empty frame stays empty', async () => {
    const res = await analyzeImage(fakeJpeg(), { speciesnet: fakeSpeciesNet([]) });
    expect(res).toEqual({
      detections: [],
      boxes: [],
      isPublic: true,
      analyzedBy: 'speciesnet-empty',
    });
  });

  it('gate at 0.6: a mid-confidence detection (0.5) is treated as empty', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ confidence: 0.5 })]),
    });
    expect(res.analyzedBy).toBe('speciesnet-empty');
    expect(res.detections).toEqual([]);
  });

  it('gate at 0.6: a confident detection (0.6) passes', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ label: 'bobcat', confidence: 0.6 })]),
    });
    expect(res.analyzedBy).toBe('speciesnet');
    expect(res.detections).toEqual([expect.objectContaining({ label: 'bobcat' })]);
  });

  it('person in frame -> private, drawn as a human box', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ category: 'person', label: 'human', confidence: 0.9 })]),
    });
    expect(res.isPublic).toBe(false);
    expect(res.boxes[0].class).toBe('human');
  });

  it('FAIL-SAFE: a faint person below the gate floor still forces private', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ category: 'person', label: null, confidence: 0.05 })]),
    });
    expect(res.detections).toEqual([]);        // frame treated as empty…
    expect(res.isPublic).toBe(false);          // …but it may never go public
    expect(res.analyzedBy).toBe('speciesnet-empty');
  });

  it('a dog by species name -> private', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ label: 'domestic dog', confidence: 0.8 })]),
    });
    expect(res.isPublic).toBe(false);
  });

  it('an animal the classifier could not NAME stays private (might be a dog)', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ label: null, confidence: 0.9 })]),
    });
    expect(res.detections).toEqual([expect.objectContaining({ label: 'animal' })]);
    expect(res.isPublic).toBe(false);
  });

  it('vehicle-only frame is public and labelled', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([snDet({ category: 'vehicle', label: 'vehicle', confidence: 0.7 })]),
    });
    expect(res.isPublic).toBe(true);
    expect(res.detections).toEqual([expect.objectContaining({ label: 'vehicle' })]);
  });

  it('an animal and a person together: both saved, photo private', async () => {
    const res = await analyzeImage(fakeJpeg(), {
      speciesnet: fakeSpeciesNet([
        snDet({ label: 'gray fox', confidence: 0.9 }),
        snDet({ category: 'person', label: 'human', confidence: 0.62 }),
      ]),
    });
    expect(res.detections.map((d) => d.label).sort()).toEqual(['gray fox', 'human']);
    expect(res.isPublic).toBe(false);
  });

  it('throws when SpeciesNet is not configured (doc stays pending)', async () => {
    await expect(analyzeImage(fakeJpeg())).rejects.toThrow(/not configured/i);
  });
});

describe('analyzePendingCaptures', () => {
  beforeEach(() => {
    m.get.mockReset().mockResolvedValue({ docs: [] });
    m.download.mockReset().mockResolvedValue([fakeJpeg()]);
    m.where.mockClear();
    m.collection.mockClear();
  });

  function pendingDoc(id: string, objectPath: string | null) {
    return {
      id,
      data: () => ({ deviceId: 'cam_a', objectPath }),
      ref: { update: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('does nothing at all when SpeciesNet is not configured', async () => {
    const res = await analyzePendingCaptures(5);
    expect(res).toEqual({ scanned: 0, analyzed: 0, errors: 0 });
    expect(m.collection).not.toHaveBeenCalled(); // no scan, no per-photo failures
  });

  it('analyzes pending docs, updates in place, sets the public gate', async () => {
    const doc = pendingDoc('p1', 'prod/uploads/a.jpg');
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const sn = fakeSpeciesNet([snDet({ label: 'raccoon', confidence: 0.9 })]);

    const res = await analyzePendingCaptures(5, sn);
    expect(res).toEqual({ scanned: 1, analyzed: 1, errors: 0 });
    expect(m.where).toHaveBeenCalledWith('analyzed', '==', false);
    expect(doc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      analyzed: true,
      public: true,            // raccoon only -> safe for the gallery
      analyzedBy: 'speciesnet',
      detections: [expect.objectContaining({ label: 'raccoon' })],
      boxes: [expect.objectContaining({ class: 'animal' })],
    }));
  });

  it('marks person captures private', async () => {
    const doc = pendingDoc('p2', 'prod/uploads/b.jpg');
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const sn = fakeSpeciesNet([snDet({ category: 'person', label: 'human', confidence: 0.7 })]);

    await analyzePendingCaptures(5, sn);
    expect(doc.ref.update).toHaveBeenCalledWith(expect.objectContaining({ public: false }));
  });

  it('one failing doc does not sink the batch; failures stay pending', async () => {
    const bad = pendingDoc('bad', 'prod/uploads/gone.jpg');
    const good = pendingDoc('good', 'prod/uploads/ok.jpg');
    m.get.mockResolvedValueOnce({ docs: [bad, good] });
    m.download
      .mockRejectedValueOnce(new Error('object not found'))
      .mockResolvedValueOnce([fakeJpeg()]);

    const res = await analyzePendingCaptures(5, fakeSpeciesNet([]));
    expect(res).toEqual({ scanned: 2, analyzed: 1, errors: 1 });
    expect(bad.ref.update).not.toHaveBeenCalled();  // stays analyzed:false
    expect(good.ref.update).toHaveBeenCalled();
  });

  it('a SpeciesNet outage leaves the doc pending for a later retry', async () => {
    const doc = pendingDoc('p3', 'prod/uploads/c.jpg');
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const broken = { detect: async () => { throw new Error('503 cold start'); } } as any;

    const res = await analyzePendingCaptures(5, broken);
    expect(res).toEqual({ scanned: 1, analyzed: 0, errors: 1 });
    expect(doc.ref.update).not.toHaveBeenCalled();
  });

  it('skips docs with no objectPath', async () => {
    const doc = pendingDoc('p4', null);
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const res = await analyzePendingCaptures(5, fakeSpeciesNet([]));
    expect(res).toEqual({ scanned: 1, analyzed: 0, errors: 0 });
    expect(doc.ref.update).not.toHaveBeenCalled();
  });
});
