'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';
import {
  BURST_MS_MIN, BURST_MS_MAX, BURST_SHOTS_MIN, BURST_SHOTS_MAX,
  BURST_MS_DEFAULT, BURST_SHOTS_DEFAULT,
} from '@/lib/captureSettings';

// ---- shared UI tokens (a tiny design system so the page reads as one thing) --
const ui = {
  green: '#15803d',
  slate: '#475569',
  border: '#e2e8f0',
  cardBg: '#ffffff',
  danger: '#b91c1c',
} as const;

const card: React.CSSProperties = {
  padding: 16,
  background: ui.cardBg,
  border: `1px solid ${ui.border}`,
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
};
const btnPrimary: React.CSSProperties = {
  background: ui.green, color: '#fff', border: 'none', borderRadius: 8,
  padding: '7px 12px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  background: '#fff', color: ui.slate, border: `1px solid ${ui.border}`,
  borderRadius: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  background: 'none', color: ui.danger, border: 'none', fontSize: 13,
  cursor: 'pointer', padding: '6px 4px',
};

type Device = {
  deviceId: string;
  status: string;
  battery: number | null;
  command: string;
  // Per-camera motion-burst capture settings (null until first configured ->
  // the camera runs its firmware defaults).
  settings: { burstMs?: number; burstMaxShots?: number; updatedAt?: number; updatedBy?: string } | null;
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

type DrawnBox = { class: 'human' | 'animal'; bbox: [number, number, number, number] };

type Detection = {
  id: string;
  deviceId: string;
  imageUrl: string | null;
  capturedAt: number;
  analyzed?: boolean;  // false = still waiting for the AI; true = the AI has run
  detections: { label?: string; confidence?: number; box?: number[] }[];
  boxes?: DrawnBox[];  // human-annotated boxes from external cameras (trail cams etc.)
};

// Canvas-overlaid image for detections that carry pre-drawn boxes (external
// data sources). Colors match the source annotations sampled from the batch.
function CaptureImage({ det, showBoxes }: { det: Detection; showBoxes: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxes = det.boxes ?? [];
  const draw = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showBoxes || !boxes.length) return;
    const sx = img.clientWidth / img.naturalWidth;
    const sy = img.clientHeight / img.naturalHeight;
    ctx.lineWidth = 2;
    for (const b of boxes) {
      ctx.strokeStyle = b.class === 'human' ? 'rgb(208,22,24)' : 'rgb(240,240,70)';
      const [x, y, w, h] = b.bbox;
      ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    }
  };
  useEffect(draw, [showBoxes, boxes]);
  return (
    <div style={{ position: 'relative', maxWidth: 320, marginTop: 8, lineHeight: 0 }}>
      <img
        ref={imgRef}
        src={det.imageUrl!}
        alt=""
        style={{ width: '100%', display: 'block' }}
        onLoad={draw}
      />
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      />
    </div>
  );
}

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [error, setError] = useState('');
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});
  // Saved Wi-Fi networks (for the per-camera "Edit Wi-Fi" picker) + inline-edit
  // state for renaming a camera and re-pointing its Wi-Fi.
  const [networks, setNetworks] = useState<{ slug: string; ssid: string }[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [editingWifi, setEditingWifi] = useState<string | null>(null);
  const [wifiSlug, setWifiSlug] = useState('');
  // Editing a camera's capture (motion-burst) settings: which device's row is
  // open, plus the two field values as strings (raw input, validated on save).
  const [editingSettings, setEditingSettings] = useState<string | null>(null);
  const [burstMsInput, setBurstMsInput] = useState('');
  const [burstShotsInput, setBurstShotsInput] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Persist the "show boxes" preference; annotated captures (external cams)
  // render red/yellow rectangles over the raw image when this is on.
  const [showBoxes, setShowBoxes] = useState(true);
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('wps.showBoxes') : null;
    if (saved !== null) setShowBoxes(saved === 'true');
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('wps.showBoxes', String(showBoxes));
  }, [showBoxes]);

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

    // Kick the in-cloud AI while the dashboard is open: any unanalyzed photos
    // get Gemini labels + boxes (keyless, server-side — see /api/analyze-pending).
    // Slower cadence than load(): each call may run several model invocations.
    // Fire-and-forget; the next load() picks up whatever finished.
    async function analyze() {
      try {
        await authedFetch('/api/analyze-pending', { method: 'POST' });
      } catch {
        /* non-fatal: photos stay "pending" and get retried next tick */
      }
    }
    analyze();
    const ta = setInterval(analyze, 30000);
    return () => {
      active = false;
      clearInterval(t);
      clearInterval(ta);
    };
  }, [user]);

  // Load saved Wi-Fi networks once signed in (for the Edit Wi-Fi dropdown).
  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      try {
        const res = await authedFetch('/api/networks');
        const data = await res.json();
        if (active && res.ok) {
          setNetworks((data.networks || []).map((n: any) => ({ slug: n.slug, ssid: n.ssid })));
        }
      } catch {
        /* non-fatal: the picker just shows "add a network" */
      }
    })();
    return () => { active = false; };
  }, [user]);

  // Rename a camera's id. The change is pushed to the board over the air (a
  // set_id command); on its next wake it adopts the new id and reboots.
  async function renameDevice(oldId: string) {
    const newId = nameInput.trim();
    if (!newId || newId === oldId) { setEditingName(null); setNameInput(''); return; }
    if (!confirm(
      `Rename camera "${oldId}" to "${newId}"?\n\n` +
      `The new name is sent to the camera over the air: on its next wake it switches ` +
      `id and reboots. Until it does, you may briefly see both the old and new names.\n\n` +
      `Photos already saved under "${oldId}" stay under that name in storage.`
    )) return;
    setError('');
    setBusyId(oldId);
    try {
      const res = await authedFetch(`/api/devices/${encodeURIComponent(oldId)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setEditingName(null);
      setNameInput('');
      // The next 10-s refresh surfaces the new (seeded) card and the old one
      // marked pending until the board applies the change.
    } catch (e: any) {
      setError(e?.message || 'Rename failed');
    } finally {
      setBusyId(null);
    }
  }

  // Re-point a camera's 2.4 GHz Wi-Fi to a saved network (pushed OTA). The board
  // auto-reverts if it can't reach the new network, so a wrong pick is recoverable.
  async function applyWifi(deviceId: string) {
    if (!wifiSlug) { setEditingWifi(null); return; }
    const net = networks.find((n) => n.slug === wifiSlug);
    if (!confirm(
      `Point "${deviceId}" at Wi-Fi network "${net?.ssid ?? wifiSlug}"?\n\n` +
      `The camera applies this on its next wake and reboots onto the new network. ` +
      `If it can't connect there within a few wakes, it automatically reverts to its ` +
      `current network.`
    )) return;
    setError('');
    setBusyId(deviceId);
    try {
      const res = await authedFetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_wifi', networkSlug: wifiSlug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Wi-Fi change failed');
      setEditingWifi(null);
      setWifiSlug('');
    } catch (e: any) {
      setError(e?.message || 'Wi-Fi change failed');
    } finally {
      setBusyId(null);
    }
  }

  // Save a camera's motion-burst capture settings (how often it photographs
  // while motion continues, and the max photos per motion event). Pushed OTA via
  // the command-poll reply; the board applies them on its next wake. The server
  // clamps to safe bounds, so a wild value here can't harm the camera.
  async function saveCaptureSettings(deviceId: string) {
    const burstMs = Number(burstMsInput);
    const burstMaxShots = Number(burstShotsInput);
    if (!Number.isFinite(burstMs) || !Number.isFinite(burstMaxShots)) {
      setError('Photo gap and max photos must both be numbers');
      return;
    }
    setError('');
    setBusyId(deviceId);
    try {
      const res = await authedFetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_capture_settings', burstMs, burstMaxShots }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Saving settings failed');
      // Reflect the clamped values the server actually stored on the card.
      setDevices((ds) => ds.map((d) =>
        d.deviceId === deviceId ? { ...d, settings: { ...(d.settings || {}), ...data.settings } } : d));
      setEditingSettings(null);
    } catch (e: any) {
      setError(e?.message || 'Saving settings failed');
    } finally {
      setBusyId(null);
    }
  }

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
  const pendingBadge: React.CSSProperties = { fontSize: 11, marginLeft: 8, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e' };
  const analyzingBadge: React.CSSProperties = { fontSize: 12, padding: '1px 8px', borderRadius: 4, background: '#e0e7ff', color: '#3730a3' };
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
    <div style={{ minHeight: '100vh' }}>
      {/* Sticky app bar: back to home, title, quick nav, who's signed in + sign out */}
      <header
        style={{
          position: 'sticky', top: 0, zIndex: 10,
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          padding: '12px 24px', background: '#ffffff',
          borderBottom: `1px solid ${ui.border}`,
        }}
      >
        <Link href="/" style={{ ...btnGhost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          ← Home
        </Link>
        <span style={{ fontWeight: 700, fontSize: 17 }}>🦝 Wildlife Monitor</span>
        <nav style={{ display: 'flex', gap: 16, fontSize: 14, color: ui.slate }}>
          <Link href="/provision" style={{ color: ui.slate }}>Set up a camera</Link>
          <Link href="/networks" style={{ color: ui.slate }}>Wi-Fi networks</Link>
        </nav>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 13, color: ui.slate }}>
          <span style={{ opacity: 0.8 }}>{user.email}</span>
          <button style={btnGhost} onClick={() => signOut(clientAuth)}>Sign out</button>
        </span>
      </header>

      <main style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 24, margin: '4px 0 4px' }}>Live dashboard</h1>
        <p style={{ marginTop: 0, color: ui.slate, fontSize: 14 }}>
          Your cameras and the animals the AI spotted.
        </p>
        {error && (
          <p style={{ color: ui.danger, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
            {error}
          </p>
        )}

        <h2 style={{ fontSize: 18 }}>Cameras</h2>
        {devices.length === 0 ? (
          <p style={{ color: ui.slate }}>No cameras registered yet. <Link href="/provision">Set one up →</Link></p>
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
              <div key={d.deviceId} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div>
                    {editingName === d.deviceId ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={nameInput}
                          onChange={(e) => setNameInput(e.target.value)}
                          placeholder="new-camera-id"
                          style={{ fontSize: 14, padding: '2px 6px' }}
                        />
                        <button style={tagBtn} disabled={busyId === d.deviceId} onClick={() => renameDevice(d.deviceId)}>
                          {busyId === d.deviceId ? 'Saving…' : 'Save'}
                        </button>
                        <button style={tagBtn} onClick={() => { setEditingName(null); setNameInput(''); }}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        <b>{d.deviceId}</b>
                        <button
                          style={tagBtn}
                          title="Rename this camera (pushed to the board over the air)"
                          onClick={() => { setEditingName(d.deviceId); setNameInput(d.deviceId); }}
                        >
                          Edit name
                        </button>
                        {' — '}{d.status === 'online' ? '🟢 online' : '⚪ ' + d.status}
                        <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>battery {d.battery ?? '—'}%</span>
                        {d.command === 'set_wifi' && <span style={pendingBadge}>⏳ applying Wi-Fi…</span>}
                        {d.command === 'set_id' && <span style={pendingBadge}>⏳ renaming…</span>}
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => sendCommand(d.deviceId, 'take_picture')} style={btnPrimary}>
                      📸 Take picture
                    </button>
                    <button
                      onClick={() => deleteDevice(d.deviceId)}
                      style={btnDanger}
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
                    {editingWifi === d.deviceId ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select value={wifiSlug} onChange={(e) => setWifiSlug(e.target.value)} style={{ fontSize: 12 }}>
                          <option value="">Choose a saved network…</option>
                          {networks.map((n) => <option key={n.slug} value={n.slug}>{n.ssid}</option>)}
                        </select>
                        <button style={tagBtn} disabled={!wifiSlug || busyId === d.deviceId} onClick={() => applyWifi(d.deviceId)}>
                          {busyId === d.deviceId ? 'Applying…' : 'Apply'}
                        </button>
                        <button style={tagBtn} onClick={() => { setEditingWifi(null); setWifiSlug(''); }}>Cancel</button>
                        {networks.length === 0 && <a href="/networks" style={{ fontSize: 11, marginLeft: 6 }}>+ add a network</a>}
                      </span>
                    ) : (
                      <>
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
                        <button
                          style={tagBtn}
                          title="Change which Wi-Fi network this camera uses (pushed over the air)"
                          onClick={() => { setEditingWifi(d.deviceId); setWifiSlug(''); }}
                        >
                          Edit Wi-Fi
                        </button>
                      </>
                    )}
                  </div>

                  <div style={cell}>
                    <b>Capture:</b>{' '}
                    {editingSettings === d.deviceId ? (
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <label style={{ fontSize: 12 }}>
                          a photo every{' '}
                          <input
                            type="number" min={BURST_MS_MIN} max={BURST_MS_MAX} step={100}
                            value={burstMsInput} onChange={(e) => setBurstMsInput(e.target.value)}
                            style={{ width: 76, fontSize: 12 }}
                          />{' '}ms
                        </label>
                        <label style={{ fontSize: 12 }}>
                          · up to{' '}
                          <input
                            type="number" min={BURST_SHOTS_MIN} max={BURST_SHOTS_MAX} step={1}
                            value={burstShotsInput} onChange={(e) => setBurstShotsInput(e.target.value)}
                            style={{ width: 60, fontSize: 12 }}
                          />{' '}per burst
                        </label>
                        <button style={tagBtn} disabled={busyId === d.deviceId} onClick={() => saveCaptureSettings(d.deviceId)}>
                          {busyId === d.deviceId ? 'Saving…' : 'Save'}
                        </button>
                        <button style={tagBtn} onClick={() => setEditingSettings(null)}>Cancel</button>
                        <span style={{ fontSize: 11, opacity: 0.7 }}>applies on the camera&apos;s next wake</span>
                      </span>
                    ) : (
                      <>
                        a photo every{' '}
                        <b>{d.settings?.burstMs ?? BURST_MS_DEFAULT} ms</b>{' '}while moving, up to{' '}
                        <b>{d.settings?.burstMaxShots ?? BURST_SHOTS_DEFAULT}</b>{' '}per burst
                        {!d.settings && <i style={{ opacity: 0.7 }}> (firmware default)</i>}
                        <button
                          style={tagBtn}
                          title="How often this camera takes a photo while motion continues, and the max photos per motion event. Pushed over the air; applied on the camera's next wake."
                          onClick={() => {
                            setEditingSettings(d.deviceId);
                            setBurstMsInput(String(d.settings?.burstMs ?? BURST_MS_DEFAULT));
                            setBurstShotsInput(String(d.settings?.burstMaxShots ?? BURST_SHOTS_DEFAULT));
                          }}
                        >
                          Edit
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

      <h2 style={{ fontSize: 18, marginTop: 24 }}>
        Recent detections{' '}
        <button
          onClick={() => setShowBoxes((v) => !v)}
          style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px' }}
        >
          {showBoxes ? 'hide boxes' : 'show boxes'}
        </button>
      </h2>
      {detections.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No detections yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {detections.map((det) => {
            const drawn = det.boxes ?? [];
            const labels = det.detections ?? [];
            // Prefer the model's per-label list (has species + confidence); fall
            // back to the drawn-box counts (external/annotated captures). The
            // key new distinction: analyzed:false → still "analyzing…", NOT the
            // same as "analyzed and found nothing".
            let summary: React.ReactNode;
            if (labels.length > 0) {
              summary = labels
                .map((x) => `${x.label ?? '?'} (${Math.round((x.confidence ?? 0) * 100)}%)`)
                .join(', ');
            } else if (drawn.length > 0) {
              const parts = [
                drawn.filter((b) => b.class === 'animal').length,
                drawn.filter((b) => b.class === 'human').length,
              ];
              summary = [`${parts[0]} animal`, `${parts[1]} human`]
                .filter((_, i) => parts[i] > 0)
                .join(' · ') || 'nothing';
            } else if (det.analyzed) {
              summary = <span style={{ opacity: 0.6 }}>no animals</span>;
            } else {
              summary = <span style={analyzingBadge}>⏳ analyzing…</span>;
            }
            return (
              <div key={det.id} style={card}>
                <b>{det.deviceId}</b>{' '}
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  {new Date(det.capturedAt).toLocaleString()}
                </span>
                <div style={{ marginTop: 2, fontSize: 15 }}>{summary}</div>
                {det.imageUrl && <CaptureImage det={det} showBoxes={showBoxes} />}
                {det.imageUrl && (
                  <a href={det.imageUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: ui.slate }}>
                    view full image
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
      </main>
    </div>
  );
}
