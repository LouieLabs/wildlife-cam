import { describe, it, expect, vi } from 'vitest';

import { createSpeciesNetClient, isSpeciesNetEnabled } from '@/lib/speciesnetClient';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const RESULT = {
  modelVersion: '4.0.3a',
  detections: [
    {
      category: 'animal',
      label: 'mule deer',
      confidence: 0.91,
      box: [100, 50, 200, 150],
      boxNorm: [0.15625, 0.104, 0.3125, 0.3125],
    },
  ],
};

describe('speciesnetClient', () => {
  it('is disabled when SPECIESNET_SERVICE_URL is unset', () => {
    expect(isSpeciesNetEnabled()).toBe(false);
  });

  it('POSTs the JPEG with a minted bearer token and parses the result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(RESULT));
    const getToken = vi.fn().mockResolvedValue('fake-id-token');
    const client = createSpeciesNetClient({
      url: 'https://sn.example.run.app',
      fetchImpl: fetchImpl as any,
      getToken,
    });

    const res = await client.detect(JPEG);

    expect(getToken).toHaveBeenCalledWith('https://sn.example.run.app');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://sn.example.run.app/detect',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-id-token',
          'Content-Type': 'image/jpeg',
        }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(res.modelVersion).toBe('4.0.3a');
    expect(res.detections).toEqual([expect.objectContaining({ label: 'mule deer', category: 'animal' })]);
  });

  it('throws on a non-2xx status (caller fails open to Gemini-only)', async () => {
    const client = createSpeciesNetClient({
      url: 'https://sn.example.run.app',
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response) as any,
      getToken: async () => 't',
    });
    await expect(client.detect(JPEG)).rejects.toThrow(/403/);
  });

  it('surfaces fetch rejection (timeout/abort) as a throw', async () => {
    const client = createSpeciesNetClient({
      url: 'https://sn.example.run.app',
      fetchImpl: vi.fn().mockRejectedValue(new Error('The operation was aborted')) as any,
      getToken: async () => 't',
    });
    await expect(client.detect(JPEG)).rejects.toThrow(/aborted/);
  });

  it('drops malformed detections instead of crashing', async () => {
    const messy = {
      modelVersion: '4.0.3a',
      detections: [
        RESULT.detections[0],
        { category: 'dragon', confidence: 0.9, box: [0, 0, 1, 1] },     // bad category
        { category: 'animal', confidence: 'high', box: [0, 0, 1, 1] },  // bad confidence
        { category: 'animal', confidence: 0.5, box: [0, 0] },           // bad box arity
        null,
      ],
    };
    const client = createSpeciesNetClient({
      url: 'https://sn.example.run.app',
      fetchImpl: vi.fn().mockResolvedValue(okResponse(messy)) as any,
      getToken: async () => 't',
    });
    const res = await client.detect(JPEG);
    expect(res.detections).toHaveLength(1);
    expect(res.detections[0].label).toBe('mule deer');
  });

  it('tolerates a body without detections (treated as empty)', async () => {
    const client = createSpeciesNetClient({
      url: 'https://sn.example.run.app',
      fetchImpl: vi.fn().mockResolvedValue(okResponse({})) as any,
      getToken: async () => 't',
    });
    const res = await client.detect(JPEG);
    expect(res).toEqual({ modelVersion: 'unknown', detections: [] });
  });
});
