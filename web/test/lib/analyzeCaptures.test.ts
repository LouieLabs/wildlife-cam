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
  jpegDimensions,
  hasPersonOrDog,
  detectWithGemini,
  analyzePendingCaptures,
} from '@/lib/analyzeCaptures';

// Minimal valid JPEG: SOI + SOF0 declaring 640x480. Header layout per spec:
// FF C0 <len:2> <precision:1> <height:2> <width:2> ...
function fakeJpeg(width = 640, height = 480): Buffer {
  return Buffer.from([
    0xff, 0xd8,                    // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08,  // SOF0, len 17, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // components
  ]);
}

// A VertexAI stand-in whose model returns the given JSON text.
function fakeVertex(jsonText: string) {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: { candidates: [{ content: { parts: [{ text: jsonText }] } }] },
      }),
    }),
  } as any;
}

describe('jpegDimensions', () => {
  it('reads width/height from a SOF0 header', () => {
    expect(jpegDimensions(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it('returns null for garbage', () => {
    expect(jpegDimensions(Buffer.from([0, 1, 2, 3]))).toBeNull();
  });
});

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

describe('detectWithGemini', () => {
  it('converts box_2d [ymin,xmin,ymax,xmax]/1000 into pixel [x,y,w,h]', async () => {
    const vertex = fakeVertex(JSON.stringify([
      { label: 'mule deer', confidence: 0.93, box_2d: [250, 500, 750, 1000] },
    ]));
    const { detections, boxes } = await detectWithGemini(fakeJpeg(640, 480), vertex);
    // x = 500/1000*640 = 320, y = 250/1000*480 = 120, w = 500/1000*640 = 320, h = 500/1000*480 = 240
    expect(detections).toEqual([{ label: 'mule deer', confidence: 0.93, box: [320, 120, 320, 240] }]);
    expect(boxes).toEqual([{ class: 'animal', bbox: [320, 120, 320, 240] }]);
  });

  it('classes person boxes as human for the dashboard overlay', async () => {
    const vertex = fakeVertex(JSON.stringify([
      { label: 'person', confidence: 0.8, box_2d: [0, 0, 500, 500] },
    ]));
    const { boxes } = await detectWithGemini(fakeJpeg(), vertex);
    expect(boxes[0].class).toBe('human');
  });

  it('handles an empty scene ([]) and drops junk entries', async () => {
    const vertex = fakeVertex(JSON.stringify([
      {},
      { label: '' },
      { notALabel: 1 },
    ]));
    const { detections, boxes, containsPersonOrDog } = await detectWithGemini(fakeJpeg(), vertex);
    expect(detections).toEqual([]);
    expect(boxes).toEqual([]);
    expect(containsPersonOrDog).toBe(false);
  });

  it('throws a clear error on non-JSON model output', async () => {
    await expect(detectWithGemini(fakeJpeg(), fakeVertex('sorry, I cannot')))
      .rejects.toThrow(/non-JSON/);
  });

  it('tolerates ```json markdown fences around the array', async () => {
    const fenced = '```json\n[{"label":"coyote","confidence":0.7,"box_2d":[0,0,100,100]}]\n```';
    const { detections } = await detectWithGemini(fakeJpeg(), fakeVertex(fenced));
    expect(detections).toEqual([expect.objectContaining({ label: 'coyote' })]);
  });

  it('drops low-confidence ANIMAL guesses below the floor (0.3)', async () => {
    const vertex = fakeVertex(JSON.stringify([
      { label: 'mule deer', confidence: 0.9, box_2d: [0, 0, 100, 100] },
      { label: 'bobcat', confidence: 0.1, box_2d: [0, 0, 100, 100] }, // below floor -> dropped
    ]));
    const { detections } = await detectWithGemini(fakeJpeg(), vertex);
    expect(detections.map((d) => d.label)).toEqual(['mule deer']);
  });

  it('FAIL-SAFE: a faint person is exempt from the floor AND trips the gate', async () => {
    const vertex = fakeVertex(JSON.stringify([
      { label: 'person', confidence: 0.08 }, // faint — but privacy-relevant
      { label: 'raccoon', confidence: 0.9, box_2d: [0, 0, 100, 100] },
    ]));
    const { detections, containsPersonOrDog } = await detectWithGemini(fakeJpeg(), vertex);
    expect(detections.map((d) => d.label).sort()).toEqual(['person', 'raccoon']);
    expect(containsPersonOrDog).toBe(true);
  });

  it('retries once on a transient Vertex error, then succeeds', async () => {
    let calls = 0;
    const vertex = {
      getGenerativeModel: () => ({
        generateContent: async () => {
          calls++;
          if (calls === 1) throw new Error('503 backend unavailable');
          return { response: { candidates: [{ content: { parts: [{ text: '[]' }] } }] } };
        },
      }),
    } as any;
    const { detections } = await detectWithGemini(fakeJpeg(), vertex);
    expect(calls).toBe(2);
    expect(detections).toEqual([]);
  });
});

describe('analyzePendingCaptures', () => {
  beforeEach(() => {
    m.get.mockReset().mockResolvedValue({ docs: [] });
    m.download.mockReset().mockResolvedValue([fakeJpeg()]);
    m.where.mockClear();
  });

  function pendingDoc(id: string, objectPath: string | null) {
    return {
      id,
      data: () => ({ deviceId: 'cam_a', objectPath }),
      ref: { update: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('analyzes pending docs, updates in place, sets the public gate', async () => {
    const doc = pendingDoc('p1', 'prod/uploads/a.jpg');
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const vertex = fakeVertex(JSON.stringify([
      { label: 'raccoon', confidence: 0.9, box_2d: [0, 0, 500, 500] },
    ]));

    const res = await analyzePendingCaptures(5, vertex);
    expect(res).toEqual({ scanned: 1, analyzed: 1, errors: 0 });
    expect(m.where).toHaveBeenCalledWith('analyzed', '==', false);
    expect(doc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      analyzed: true,
      public: true,           // raccoon only -> safe for the gallery
      detections: [expect.objectContaining({ label: 'raccoon' })],
    }));
  });

  it('marks person captures private', async () => {
    const doc = pendingDoc('p2', 'prod/uploads/b.jpg');
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const vertex = fakeVertex(JSON.stringify([{ label: 'person', confidence: 0.7 }]));

    await analyzePendingCaptures(5, vertex);
    expect(doc.ref.update).toHaveBeenCalledWith(expect.objectContaining({ public: false }));
  });

  it('one failing doc does not sink the batch; failures stay pending', async () => {
    const bad = pendingDoc('bad', 'prod/uploads/gone.jpg');
    const good = pendingDoc('good', 'prod/uploads/ok.jpg');
    m.get.mockResolvedValueOnce({ docs: [bad, good] });
    m.download
      .mockRejectedValueOnce(new Error('object not found'))
      .mockResolvedValueOnce([fakeJpeg()]);
    const vertex = fakeVertex('[]');

    const res = await analyzePendingCaptures(5, vertex);
    expect(res).toEqual({ scanned: 2, analyzed: 1, errors: 1 });
    expect(bad.ref.update).not.toHaveBeenCalled();  // stays analyzed:false
    expect(good.ref.update).toHaveBeenCalled();
  });

  it('skips docs with no objectPath', async () => {
    const doc = pendingDoc('p3', null);
    m.get.mockResolvedValueOnce({ docs: [doc] });
    const res = await analyzePendingCaptures(5, fakeVertex('[]'));
    expect(res).toEqual({ scanned: 1, analyzed: 0, errors: 0 });
    expect(doc.ref.update).not.toHaveBeenCalled();
  });
});
