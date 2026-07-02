'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

type CameraType = 'networked' | 'external';

export default function RegisterPage() {
  const [user, setUser] = useState<User | null>(null);
  const [cameraType, setCameraType] = useState<CameraType>('networked');
  const [deviceId, setDeviceId] = useState('');
  const [mac, setMac] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [nightMode, setNightMode] = useState<'infrared' | 'white_flash' | ''>('');
  const [deployment, setDeployment] = useState('');
  const [result, setResult] = useState<{ secret: string | null; cameraType: CameraType } | null>(null);
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
      const payload: Record<string, string> = { deviceId, mac, cameraType };
      if (cameraType === 'external') {
        payload.manufacturer = manufacturer;
        payload.model = model;
        payload.nightMode = nightMode;
        payload.deployment = deployment;
      }
      const res = await fetch('/api/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
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

  const isExternal = cameraType === 'external';

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <h1>Register a camera</h1>
      <form onSubmit={handleRegister}>
        <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, margin: '0 0 16px 0' }}>
          <legend style={{ padding: '0 6px', fontSize: 13 }}>Camera type</legend>
          <label style={{ display: 'block', marginBottom: 6 }}>
            <input
              type="radio"
              name="cameraType"
              value="networked"
              checked={cameraType === 'networked'}
              onChange={() => setCameraType('networked')}
            />{' '}
            <b>Networked</b> — a Heltec / Lilygo fleet camera that talks to us over the network.
          </label>
          <label style={{ display: 'block' }}>
            <input
              type="radio"
              name="cameraType"
              value="external"
              checked={cameraType === 'external'}
              onChange={() => setCameraType('external')}
            />{' '}
            <b>External / non-networked</b> — a trail cam or imported dataset. Photos come in via a developer ingest script; no secret, no live commands.
          </label>
        </fieldset>

        <label>
          Device ID<br />
          <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder={isExternal ? 'WPS-1' : 'pond_cam_01'} />
        </label>
        <br /><br />
        <label>
          MAC address {isExternal ? '(optional for external cams)' : '(12 hex characters)'}<br />
          <input
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder={isExternal ? 'leave blank if unknown' : '240AC4000110'}
          />
        </label>

        {isExternal && (
          <>
            <br /><br />
            <label>
              Manufacturer<br />
              <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="UOVision/WPS" />
            </label>
            <br /><br />
            <label>
              Model<br />
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Home Guard W5 L5P-W" />
            </label>
            <br /><br />
            <label>
              Night mode<br />
              <select value={nightMode} onChange={(e) => setNightMode(e.target.value as any)}>
                <option value="">(unknown)</option>
                <option value="infrared">Infrared (IR mono)</option>
                <option value="white_flash">White flash (color)</option>
              </select>
            </label>
            <br /><br />
            <label>
              Deployment (free text)<br />
              <input value={deployment} onChange={(e) => setDeployment(e.target.value)} placeholder="e.g. multiple spots in LL backyard" style={{ width: '100%' }} />
            </label>
          </>
        )}

        <br /><br />
        <button disabled={busy} type="submit">{busy ? 'Registering…' : 'Register'}</button>
      </form>

      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      {result && result.cameraType === 'networked' && result.secret && (
        <div style={{ marginTop: 16, padding: 12, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <p>✅ Registered! Flash this secret into the camera firmware:</p>
          <p style={{ fontSize: 28, fontFamily: 'monospace', letterSpacing: 2 }}>{result.secret}</p>
          <p style={{ fontSize: 12, opacity: 0.8 }}>
            Lost it later? Look it up again on the <a href="/dashboard">dashboard</a>.
          </p>
        </div>
      )}

      {result && result.cameraType === 'external' && (
        <div style={{ marginTop: 16, padding: 12, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <p>✅ Registered as an external camera. No secret is issued — photos come in via a developer ingest script.</p>
          <p style={{ fontSize: 12, opacity: 0.8 }}>
            See it on the <a href="/dashboard">dashboard</a>.
          </p>
        </div>
      )}
    </main>
  );
}
