import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  rtdbGet: vi.fn(),
  rtdbSet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rtdb', () => ({ rtdbGet: m.rtdbGet, rtdbSet: m.rtdbSet }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { POST } from '@/app/api/devices/[deviceId]/rename/route';

const okLimit = { allowed: true, count: 1, limit: 10, windowMs: 60_000, retryAfterMs: 0 };
const ctx = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) });
const call = (deviceId: string, body: unknown) =>
  POST(makeRequest({ method: 'POST', headers: { Authorization: 'Bearer x' }, body }), ctx(deviceId));

describe('POST /api/devices/[deviceId]/rename', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbGet.mockReset();
    m.rtdbSet.mockReset().mockResolvedValue(undefined);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('rejects unauthenticated (401) and writes nothing', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await call('cam_a', { newId: 'cam_b' });
    expect(res.status).toBe(401);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects a malformed new id (400) before any DB work', async () => {
    const res = await call('cam_a', { newId: 'x' });
    expect(res.status).toBe(400);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('rejects renaming to the same id (400)', async () => {
    const res = await call('cam_a', { newId: 'cam_a' });
    expect(res.status).toBe(400);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('404 when the camera does not exist', async () => {
    m.rtdbGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const res = await call('cam_a', { newId: 'cam_b' });
    expect(res.status).toBe(404);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('400 for an external camera with no secret / command channel', async () => {
    m.rtdbGet
      .mockResolvedValueOnce({ cameraType: 'external' }) // device_meta/old
      .mockResolvedValueOnce(null)                       // pre_shared_keys/old (none)
      .mockResolvedValueOnce(null);                      // devices/old
    const res = await call('cam_a', { newId: 'cam_b' });
    expect(res.status).toBe(400);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('409 when the target id is already taken', async () => {
    m.rtdbGet
      .mockResolvedValueOnce({ cameraType: 'networked' }) // meta/old
      .mockResolvedValueOnce('secret-xyz')               // secret/old
      .mockResolvedValueOnce({ state: {} })              // devices/old
      .mockResolvedValueOnce({ mac: 'ZZ' })              // meta/new EXISTS
      .mockResolvedValueOnce(null);                      // secret/new
    const res = await call('cam_a', { newId: 'cam_b' });
    expect(res.status).toBe(409);
    expect(m.rtdbSet).not.toHaveBeenCalledWith('pre_shared_keys/cam_b', 'secret-xyz');
  });

  it('happy path: copies old->new (same secret) and queues set_id on the old node', async () => {
    m.rtdbGet
      .mockResolvedValueOnce({ mac: 'AABBCC', cameraType: 'networked' }) // meta/old
      .mockResolvedValueOnce('secret-xyz')                              // secret/old
      .mockResolvedValueOnce({ state: { status: 'online' } })           // devices/old
      .mockResolvedValueOnce(null)                                      // meta/new (free)
      .mockResolvedValueOnce(null);                                     // secret/new (free)
    const res = await call('cam_a', { newId: 'cam_b' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: { from: 'cam_a', to: 'cam_b' }, pending: true });

    // New registration copied with the SAME secret + carried-over meta.
    expect(m.rtdbSet).toHaveBeenCalledWith('pre_shared_keys/cam_b', 'secret-xyz');
    expect(m.rtdbSet).toHaveBeenCalledWith(
      'device_meta/cam_b',
      expect.objectContaining({ mac: 'AABBCC', renamedFrom: 'cam_a' }),
    );
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_b/state', { status: 'online' });
    // Rename queued on the OLD node: payload then verb.
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/idTarget', { newId: 'cam_b' });
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/command', 'set_id');
  });
});
