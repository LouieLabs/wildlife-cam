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
  wifiSsid: string | null;
  halowSsid: string | null;
  netMode: 'wifi' | 'halow' | 'both' | null;
  // Rename audit trail (server fills these).
  metaStatus: 'renamed' | null;
  renamedTo: string | null;
  renamedAt: number | null;
  previousId: string | null;
};

// 24h after a rename, if the new id still hasn't reported, escalate the banner
// to "may be offline" -- field cameras can sleep through cold nights, so don't
// flag earlier than that.
const RENAME_STALE_MS = 24 * 3600 * 1000;

// "2 h ago", "3 d ago", "—" if unknown. Coarse: surfaces "offline > 24h" at
// the dashboard glance, exact wall-clock isn't useful for a sleeping camera.
function relativeAge(ts: number | null): string {
  if (!ts) return '—';
  const ms = Date.now() - ts;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

function networkLabel(d: Device): string | null {
  const parts: string[] = [];
  if (d.wifiSsid)  parts.push(`${d.wifiSsid} (2.4 GHz)`);
  if (d.halowSsid) parts.push(`${d.halowSsid} (HaLow)`);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  // "both" -- show in preferred order
  return parts.join(' + ');
}

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

  // Rename modal state. renamingFrom = the deviceId whose modal is open.
  const [renamingFrom, setRenamingFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

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

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renamingFrom) return;
    setRenameError('');
    const newId = renameTo.toLowerCase().trim();
    if (!/^[a-z0-9_-]{3,40}$/.test(newId)) {
      setRenameError('Use 3-40 of: a-z, 0-9, _ or -');
      return;
    }
    if (newId === renamingFrom) {
      setRenameError('New name must differ from current');
      return;
    }
    setRenameBusy(true);
    try {
      const res = await authedFetch('/api/rename-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldId: renamingFrom, newId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rename failed');
      setRenamingFrom(null);
      setRenameTo('');
      // Best-effort immediate refresh; the 10-s interval would catch it anyway.
      try {
        const dRes = await authedFetch('/api/devices');
        const dData = await dRes.json();
        if (dRes.ok) setDevices(dData.devices);
      } catch {}
    } catch (e: any) {
      setRenameError(e?.message || 'Rename failed');
    } finally {
      setRenameBusy(false);
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
      {(() => {
        const byId = new Map(devices.map((d) => [d.deviceId, d]));
        // A tombstone is "confirmed archived" only once the new id has actually
        // checked in (lastUpdate after the rename time). Until then it stays in
        // the Active section showing "renamed → X, awaiting confirmation".
        const confirmedArchived = (t: Device): boolean => {
          if (t.metaStatus !== 'renamed' || !t.renamedTo) return false;
          const tgt = byId.get(t.renamedTo);
          return !!(tgt?.lastUpdate && t.renamedAt && tgt.lastUpdate > t.renamedAt);
        };
        const active = devices.filter((d) => d.metaStatus !== 'renamed' || !confirmedArchived(d));
        const archived = devices.filter((d) => d.metaStatus === 'renamed' && confirmedArchived(d));

        if (active.length === 0 && archived.length === 0) {
          return <p>No cameras registered yet.</p>;
        }

        const renderActive = (d: Device) => {
          const net = networkLabel(d);
          const isPendingTomb = d.metaStatus === 'renamed';
          // "New side" of a recent rename: previousId set + has either no
          // check-in yet or one older than the rename event.
          const isFreshNewId = !!d.previousId && d.renamedAt
            && (!d.lastUpdate || d.lastUpdate < d.renamedAt);
          const renameStale = !!d.renamedAt
            && (Date.now() - d.renamedAt > RENAME_STALE_MS)
            && (!d.lastUpdate || (d.renamedAt && d.lastUpdate < d.renamedAt));

          return (
            <div
              key={d.deviceId}
              style={{
                padding: 12,
                background: isPendingTomb ? '#f8fafc' : '#f1f5f9',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                opacity: isPendingTomb ? 0.7 : 1,
              }}
            >
              <b>{d.deviceId}</b>
              {!isPendingTomb && <> — {d.status === 'online' ? '🟢 online' : '⚪ ' + d.status}</>}

              {isPendingTomb && d.renamedTo && (
                <div style={{ marginTop: 6, padding: 6, background: '#e2e8f0', borderRadius: 4, fontSize: 13 }}>
                  Renamed to <b>{d.renamedTo}</b> — awaiting confirmation
                  {renameStale && (
                    <div style={{ marginTop: 4, color: '#b45309' }}>
                      ⚠️ Pending {'>'}24h — board may be offline.
                    </div>
                  )}
                </div>
              )}
              {isFreshNewId && d.previousId && !isPendingTomb && (
                <div style={{ marginTop: 6, padding: 6, background: '#fef9c3', borderRadius: 4, fontSize: 13 }}>
                  Renamed from <b>{d.previousId}</b> — awaiting first check-in
                  {renameStale && (
                    <div style={{ marginTop: 4, color: '#b45309' }}>
                      ⚠️ {'>'}24h without check-in — board may be offline.
                    </div>
                  )}
                </div>
              )}

              {!isPendingTomb && <div>Battery: {d.battery ?? '—'}%</div>}
              <div style={{ fontSize: 12, opacity: 0.7 }}>MAC: {d.mac ?? '—'}</div>
              {net && (
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Expects: {net} · last seen {relativeAge(d.lastUpdate)}
                </div>
              )}
              {!isPendingTomb && (
                <div style={{ fontSize: 12, opacity: 0.7 }}>Pending command: {d.command}</div>
              )}
              {!isPendingTomb && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => sendCommand(d.deviceId, 'take_picture')}>📸 Take picture</button>
                  <button
                    onClick={() => { setRenamingFrom(d.deviceId); setRenameTo(''); setRenameError(''); }}
                  >
                    ✏️ Rename
                  </button>
                </div>
              )}
            </div>
          );
        };

        return (
          <>
            {active.length === 0 ? (
              <p>No active cameras.</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>{active.map(renderActive)}</div>
            )}

            {archived.length > 0 && (
              <>
                <h3 style={{ fontSize: 14, marginTop: 24, opacity: 0.6 }}>
                  Archived ({archived.length})
                </h3>
                <div style={{ display: 'grid', gap: 8 }}>
                  {archived.map((d) => (
                    <div
                      key={d.deviceId}
                      style={{
                        padding: 8,
                        background: '#fafafa',
                        border: '1px dashed #e2e8f0',
                        borderRadius: 6,
                        fontSize: 13,
                        opacity: 0.75,
                      }}
                    >
                      <b>{d.deviceId}</b> — renamed → <b>{d.renamedTo}</b>{' '}
                      {d.renamedAt && (
                        <span style={{ opacity: 0.7 }}>
                          on {new Date(d.renamedAt).toLocaleDateString()}
                        </span>
                      )}
                      <div style={{ fontSize: 11, opacity: 0.6 }}>MAC: {d.mac ?? '—'}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        );
      })()}

      {renamingFrom && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
          }}
          onClick={() => !renameBusy && setRenamingFrom(null)}
        >
          <form
            onSubmit={submitRename}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', padding: 20, borderRadius: 8, minWidth: 320,
              boxShadow: '0 6px 24px rgba(0,0,0,0.15)',
            }}
          >
            <h3 style={{ marginTop: 0, fontSize: 16 }}>Rename <code>{renamingFrom}</code></h3>
            <p style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
              MAC stays put; the old name is archived (history is kept). The board
              learns its new name on its next wake.
            </p>
            <input
              autoFocus
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
              placeholder="new-camera-name"
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 8 }}
              disabled={renameBusy}
            />
            <small style={{ display: 'block', marginTop: 4, color: renameError ? '#c0392b' : '#888' }}>
              {renameError || 'Use 3-40 of: a-z, 0-9, _ or -'}
            </small>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setRenamingFrom(null)} disabled={renameBusy}>
                Cancel
              </button>
              <button type="submit" disabled={renameBusy}>
                {renameBusy ? 'Renaming…' : 'Rename'}
              </button>
            </div>
          </form>
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

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #e2e8f0' }} />
      <h2 style={{ fontSize: 18 }}>Recover a device secret</h2>
      <form onSubmit={lookupSecretFor}>
        <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="pond_cam_01" />
        <button type="submit" style={{ marginLeft: 8 }}>Look up</button>
      </form>
      {lookupSecret && <p style={{ fontFamily: 'monospace', fontSize: 20 }}>{lookupSecret}</p>}
    </main>
  );
}
