'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

export default function RegisterPage() {
  const [user, setUser] = useState<User | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [mac, setMac] = useState('');
  const [result, setResult] = useState<{ secret: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const token = await user!.getIdToken();
      const res = await fetch('/api/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId, mac }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setResult(data);
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setBusy(false);
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
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <h1>Register a camera</h1>
      <form onSubmit={handleRegister}>
        <label>
          Device ID<br />
          <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="pond_cam_01" />
        </label>
        <br /><br />
        <label>
          MAC address (12 hex characters)<br />
          <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="240AC4000110" />
        </label>
        <br /><br />
        <button disabled={busy} type="submit">{busy ? 'Registering…' : 'Register'}</button>
      </form>

      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 16, padding: 12, background: '#1e293b', borderRadius: 8 }}>
          <p>✅ Registered! Flash this secret into the camera firmware:</p>
          <p style={{ fontSize: 28, fontFamily: 'monospace', letterSpacing: 2 }}>{result.secret}</p>
          <p style={{ fontSize: 12, opacity: 0.8 }}>
            Lost it later? Look it up again on the <a href="/dashboard">dashboard</a>.
          </p>
        </div>
      )}
    </main>
  );
}
