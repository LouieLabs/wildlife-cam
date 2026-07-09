import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireDeviceSecret: vi.fn(),
  rtdbGet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireDeviceSecret', () => ({ requireDeviceSecret: m.requireDeviceSecret }));
vi.mock('@/lib/rtdb', () => ({ rtdbGet: m.rtdbGet, rtdbSet: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { POST } from '@/app/api/command-poll/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/command-poll', () => {
  beforeEach(() => {
    m.requireDeviceSecret.mockReset().mockResolvedValue(undefined);
    m.rtdbGet.mockReset().mockResolvedValue('idle');
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('returns 429 BEFORE any auth or DB work when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a' } }));
    expect(res.status).toBe(429);
    expect(m.requireDeviceSecret).not.toHaveBeenCalled();
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('rejects when the per-device secret is wrong (401)', async () => {
    m.requireDeviceSecret.mockRejectedValueOnce(new HttpError(401, 'Unauthorized device'));
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'WRONG' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(401);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('returns the pending command on the happy path', async () => {
    m.rtdbGet.mockResolvedValueOnce('take_picture');
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'take_picture' });
    expect(m.rtdbGet).toHaveBeenCalledWith('devices/cam_a/command');
  });

  it('defaults to "idle" when the command path is missing/null', async () => {
    m.rtdbGet.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'idle' });
  });

  // ---- OTA payload extension (Slice B) ------------------------------------
  // When the command is "update_firmware", the response includes the ota
  // object we wrote at /devices/<id>/otaTarget. Slice A firmware parses this
  // exact shape.

  const VALID_OTA_TARGET = {
    url: 'https://ex.com/firmware/builds/heltec-ht-hc33/a1b2c3d/firmware.bin',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    sizeBytes: 1174480,
    version: 'a1b2c3d',
    boardType: 'heltec-ht-hc33',
    expectedSeconds: 30,
    minBytesPerSec: 20000,
    maxSeconds: 90,
  };

  it('embeds the ota object when the command is "update_firmware"', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('update_firmware')   // devices/cam_a/command
      .mockResolvedValueOnce(VALID_OTA_TARGET);   // devices/cam_a/otaTarget
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceId: 'cam_a',
      command: 'update_firmware',
      ota: VALID_OTA_TARGET,
    });
    expect(m.rtdbGet).toHaveBeenCalledWith('devices/cam_a/command');
    expect(m.rtdbGet).toHaveBeenCalledWith('devices/cam_a/otaTarget');
  });

  it('does NOT touch otaTarget when the command is "take_picture"', async () => {
    m.rtdbGet.mockResolvedValueOnce('take_picture');
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'take_picture' });
    expect(m.rtdbGet).toHaveBeenCalledTimes(1);   // no otaTarget read
  });

  it('drops the ota key when otaTarget is missing (malformed dashboard state)', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('update_firmware')
      .mockResolvedValueOnce(null);
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'update_firmware' });
  });

  it('drops the ota key when otaTarget is missing required fields', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('update_firmware')
      .mockResolvedValueOnce({ url: '', sha256: '', sizeBytes: 0 });   // half payload
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ota).toBeUndefined();
    expect(body.command).toBe('update_firmware');
  });

  // ---- set_wifi payload -----------------------------------------------------

  it('embeds the wifi object when the command is "set_wifi"', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('set_wifi')                                   // command
      .mockResolvedValueOnce({ ssid: 'School-WiFi', pass: 'pw12345678', netMode: 'wifi' }); // wifiTarget
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceId: 'cam_a',
      command: 'set_wifi',
      wifi: { ssid: 'School-WiFi', pass: 'pw12345678', netMode: 'wifi' },
    });
    expect(m.rtdbGet).toHaveBeenCalledWith('devices/cam_a/wifiTarget');
  });

  it('defaults netMode to "wifi" and allows an empty password (open network)', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('set_wifi')
      .mockResolvedValueOnce({ ssid: 'OpenAP', pass: '' });   // no netMode
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    const body = await res.json();
    expect(body.wifi).toEqual({ ssid: 'OpenAP', pass: '', netMode: 'wifi' });
  });

  it('drops the wifi key when the target has no ssid (malformed)', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('set_wifi')
      .mockResolvedValueOnce({ pass: 'x' });   // no ssid
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    const body = await res.json();
    expect(body.wifi).toBeUndefined();
    expect(body.command).toBe('set_wifi');
  });

  // ---- set_id payload -------------------------------------------------------

  it('embeds the rename object when the command is "set_id"', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('set_id')            // command
      .mockResolvedValueOnce({ newId: 'pond_cam_02' }); // idTarget
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceId: 'cam_a',
      command: 'set_id',
      rename: { newId: 'pond_cam_02' },
    });
  });

  it('drops the rename key when the new id is malformed', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('set_id')
      .mockResolvedValueOnce({ newId: 'no spaces allowed!' });
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    const body = await res.json();
    expect(body.rename).toBeUndefined();
    expect(body.command).toBe('set_id');
  });
});
