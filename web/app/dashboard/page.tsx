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
  firmwareVersion: string | null;
  netMode: string | null;
  wifiSsid: string | null;
  wifiPass: string | null;
  halowSsid: string | null;
  halowPsk: string | null;
  secret: string | null;
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
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});

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

  async function deleteDevice(deviceId: string) {
    if (!confirm(
      `Delete camera "${deviceId}"?\n\n` +
      `This removes the registration, secret, and live state from the dashboard. ` +
      `It CANNOT be undone.\n\n` +
      `Photos already in cloud storage are NOT touched. If you re-register the same ` +
      `name later, new photos will land alongside the old ones under the same folder.`
    )) return;
    setError('');
    try {
      const res = await authedFetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      // Optimistically drop it from the list; the next 10-s refresh would do the same.
      setDevices((ds) => ds.filter((d) => d.deviceId !== deviceId));
    } catch (e: any) {
      setError(e?.message || 'Delete failed');
    }
  }

  if (!user) {
    return (
      <main style={{ padding: 24 }}>
        <p>Please <a href="/login">sign in</a> first.</p>
      </main>
    );
  }

  const cell: React.CSSProperties = { fontSize: 12, opacity: 0.8 };
  const tagBtn: React.CSSProperties = { fontSize: 11, padding: '2px 6px', marginLeft: 6, cursor: 'pointer' };
  // Render a "label: value (Reveal)" pair where value is masked until clicked.
  // Used for both per-camera Wi-Fi/HaLow passwords and the device secret.
  function renderSecretField(label: string, value: string | null, key: string, revealedMap: Record<string, boolean>, setRevealedMap: (m: Record<string, boolean>) => void) {
    if (value === null) {
      return <div style={cell}><span style={{ opacity: 0.6 }}>{label}: <i>not provisioned</i></span></div>;
    }
    const shown = !!revealedMap[key];
    return (
      <div style={cell}>
        {label}: <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{shown ? value : '••••••••'}</code>
        <button
          style={tagBtn}
          onClick={() => setRevealedMap({ ...revealedMap, [key]: !shown })}
        >
          {shown ? 'Hide' : 'Reveal'}
        </button>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: 24 }}>
      <h1>Live dashboard</h1>
      <nav style={{ display: 'flex', gap: 14, fontSize: 14, margin: '4px 0 16px', color: '#475569' }}>
        <a href="/provision">Set up a camera</a>
        <a href="/networks">Saved Wi-Fi networks</a>
      </nav>
      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      <h2 style={{ fontSize: 18 }}>Cameras</h2>
      {devices.length === 0 ? (
        <p>No cameras registered yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {devices.map((d) => {
            // For Wi-Fi we show both SSID + password (rendered together so they
            // share the same Reveal/Hide toggle). For HaLow same idea. The
            // saved-networks notebook handles the per-network case; this is the
            // per-CAMERA view of what creds the board actually has in NVS.
            const wifiKey = `wifi:${d.deviceId}`;
            const halowKey = `halow:${d.deviceId}`;
            const wifiShown = !!revealedPasswords[wifiKey];
            const halowShown = !!revealedPasswords[halowKey];
            return (
              <div key={d.deviceId} style={{ padding: 12, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <b>{d.deviceId}</b> — {d.status === 'online' ? '🟢 online' : '⚪ ' + d.status}
                    <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>battery {d.battery ?? '—'}%</span>
                  </div>
                  <div>
                    <button onClick={() => sendCommand(d.deviceId, 'take_picture')} style={{ marginRight: 6 }}>
                      📸 Take picture
                    </button>
                    <button
                      onClick={() => deleteDevice(d.deviceId)}
                      style={{ color: '#c0392b', fontSize: 13, cursor: 'pointer' }}
                      title="Remove camera from the dashboard. GCS photos are preserved."
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 6, lineHeight: 1.5 }}>
                  <div style={cell}>MAC: {d.mac ?? '—'} · firmware: {d.firmwareVersion ?? '—'} · pending: {d.command}</div>

                  <div style={cell}>
                    <b>Wi-Fi:</b>{' '}
                    {d.wifiSsid === null ? <i style={{ opacity: 0.7 }}>not provisioned</i> : (
                      <>
                        <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{d.wifiSsid}</code>
                        {' / '}
                        <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{wifiShown ? (d.wifiPass ?? '') : '••••••••'}</code>
                        <button style={tagBtn} onClick={() => setRevealedPasswords({ ...revealedPasswords, [wifiKey]: !wifiShown })}>
                          {wifiShown ? 'Hide' : 'Reveal'}
                        </button>
                      </>
                    )}
                  </div>

                  <div style={cell}>
                    <b>HaLow:</b>{' '}
                    {d.halowSsid === null ? <i style={{ opacity: 0.7 }}>not provisioned</i> : (
                      <>
                        <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{d.halowSsid}</code>
                        {' / '}
                        <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{halowShown ? (d.halowPsk ?? '') : '••••••••'}</code>
                        <button style={tagBtn} onClick={() => setRevealedPasswords({ ...revealedPasswords, [halowKey]: !halowShown })}>
                          {halowShown ? 'Hide' : 'Reveal'}
                        </button>
                      </>
                    )}
                  </div>

                  {renderSecretField('Device secret', d.secret, d.deviceId, revealedSecrets, setRevealedSecrets)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 style={{ fontSize: 18, marginTop: 24 }}>Recent detections</h2>
      {detections.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No detections yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {detections.map((det) => (
            <div key={det.id} style={{ padding: 12, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8 }}>
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
    </main>
  );
}
