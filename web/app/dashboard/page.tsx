'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

type Device = {
  deviceId: string;
  status: string;
  battery: number | null;
  command: string;
  mac: string | null;
  lastUpdate: number | null;
};

type Detection = {
  id: string;
  deviceId: string;
  imageUrl: string | null;
  capturedAt: number;
  detections: { label?: string; confidence?: number; box?: number[] }[];
};

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [error, setError] = useState('');

  const [lookupId, setLookupId] = useState('');
  const [lookupSecret, setLookupSecret] = useState('');

  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  async function authedFetch(url: string, init: RequestInit = {}) {
    const token = await user!.getIdToken();
    return fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
  }

  useEffect(() => {
    if (!user) return;
    let active = true;
    async function load() {
      try {
        const [dRes, detRes] = await Promise.all([
          authedFetch('/api/devices'),
          authedFetch('/api/detections'),
        ]);
        const dData = await dRes.json();
        const detData = await detRes.json();
        if (!dRes.ok) throw new Error(dData.error || 'Failed to load devices');
        if (active) {
          setDevices(dData.devices);
          if (detRes.ok) setDetections(detData.detections);
        }
      } catch (e: any) {
        if (active) setError(e?.message || 'Failed');
      }
    }
    load();
    const t = setInterval(load, 10000); // refresh every 10s
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [user]);

  async function sendCommand(deviceId: string, action: string) {
    setError('');
    try {
      const res = await authedFetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Command failed');
    } catch (e: any) {
      setError(e?.message || 'Command failed');
    }
  }

  async function lookupSecretFor(e: React.FormEvent) {
    e.preventDefault();
    setLookupSecret('');
    try {
      const res = await authedFetch(`/api/device-secret?deviceId=${encodeURIComponent(lookupId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setLookupSecret(data.secret);
    } catch (e: any) {
      setError(e?.message || 'Lookup failed');
    }
  }

  if (!user) {
    return (
      <main style={{ padding: 24 }}>
        <p>Please <a href="/login">sign in</a> first.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
      <h1>Live dashboard</h1>
      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      <h2 style={{ fontSize: 18 }}>Cameras</h2>
      {devices.length === 0 ? (
        <p>No cameras reporting yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {devices.map((d) => (
            <div key={d.deviceId} style={{ padding: 12, background: '#1e293b', borderRadius: 8 }}>
              <b>{d.deviceId}</b> — {d.status === 'online' ? '🟢 online' : '⚪ ' + d.status}
              <div>Battery: {d.battery ?? '—'}%</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>MAC: {d.mac ?? '—'}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Pending command: {d.command}</div>
              <button onClick={() => sendCommand(d.deviceId, 'take_picture')} style={{ marginTop: 8 }}>
                📸 Take picture
              </button>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 18, marginTop: 24 }}>Recent detections</h2>
      {detections.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No detections yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {detections.map((det) => (
            <div key={det.id} style={{ padding: 12, background: '#1e293b', borderRadius: 8 }}>
              <b>{det.deviceId}</b>{' '}
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {new Date(det.capturedAt).toLocaleString()}
              </span>
              <div>
                {det.detections.length === 0
                  ? 'no animals'
                  : det.detections.map((x, i) => `${x.label ?? '?'} (${Math.round((x.confidence ?? 0) * 100)}%)`).join(', ')}
              </div>
              {det.imageUrl && (
                <a href={det.imageUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  view image
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      <hr style={{ margin: '24px 0', borderColor: '#334155' }} />
      <h2 style={{ fontSize: 18 }}>Recover a device secret</h2>
      <form onSubmit={lookupSecretFor}>
        <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="pond_cam_01" />
        <button type="submit" style={{ marginLeft: 8 }}>Look up</button>
      </form>
      {lookupSecret && <p style={{ fontFamily: 'monospace', fontSize: 20 }}>{lookupSecret}</p>}
    </main>
  );
}
