'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

type Device = {
  deviceId: string;
  status: string;
  battery: number | null;
  mac: string | null;
  lastUpdate: number | null;
};

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState('');

  // secret-recovery lookup
  const [lookupId, setLookupId] = useState('');
  const [lookupSecret, setLookupSecret] = useState('');

  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    async function load() {
      try {
        const token = await user!.getIdToken();
        const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        if (active) setDevices(data.devices);
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

  async function lookupSecretFor(e: React.FormEvent) {
    e.preventDefault();
    setLookupSecret('');
    try {
      const token = await user!.getIdToken();
      const res = await fetch(`/api/device-secret?deviceId=${encodeURIComponent(lookupId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setLookupSecret(data.secret);
    } catch (e: any) {
      setLookupSecret('');
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
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1>Live dashboard</h1>
      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      {devices.length === 0 ? (
        <p>No cameras reporting yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {devices.map((d) => (
            <div key={d.deviceId} style={{ padding: 12, background: '#1e293b', borderRadius: 8 }}>
              <b>{d.deviceId}</b> — {d.status === 'online' ? '🟢 online' : '⚪ ' + d.status}
              <div>Battery: {d.battery ?? '—'}%</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>MAC: {d.mac ?? '—'}</div>
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
      {lookupSecret && (
        <p style={{ fontFamily: 'monospace', fontSize: 20 }}>{lookupSecret}</p>
      )}
    </main>
  );
}
