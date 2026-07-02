'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

// ---------------------------------------------------------------------------
// Dashboard page: publish an OTA firmware update to a set of cameras.
//
// In plain words: pick which kind of board you want to update (Heltec HT-HC33
// today), pick which specific build (identified by its git SHA), pick which
// cameras from that same board family, hit "Publish." Each camera picks up
// the update on its next timer wake. This page never talks to the fleet
// directly -- it just tells the /api/firmware/publish route what to do.
//
// Design notes anchored in docs/FLASH_STORAGE_OTA_PLAN.md (Step 3):
//   * Board-type dropdown drives everything else -- see Issue 9A (three-layer
//     board gate). Filtering builds AND cameras by boardType makes the UI
//     path itself the first layer of the defense-in-depth guard.
//   * We render Heltec-only right now because Slice C only compiles the
//     Heltec image; the Lilygo entry surfaces once TODOS.md item 5 lands.
//   * Publishing is a POST that returns per-device published[] + errors[].
//     We show both so an admin sees exactly what actually happened -- e.g. a
//     camera that hasn't reported its boardType yet gets flagged, not
//     silently skipped.
// ---------------------------------------------------------------------------

type Build = {
  boardType: string;
  sha: string;
  sizeBytes: number;
  mtime: number;
};

type Device = {
  deviceId: string;
  status: string;
  battery: number | null;
  boardType: string | null;
  firmwareVersion: string | null;
  lastOta: {
    result: string;
    from: string;
    to: string;
    durationS: number;
    ts: number;
  } | null;
  lastUpdate: number | null;
};

type PublishResult = {
  buildSha: string;
  boardType: string;
  sizeBytes: number;
  sha256: string;
  published: string[];
  errors: { deviceId: string; reason: string }[];
};

const cell: React.CSSProperties = {
  padding: 12,
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
};

const btn: React.CSSProperties = {
  padding: '6px 14px',
  border: '1px solid #cbd5e1',
  background: '#ffffff',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: '#2563eb',
  color: '#ffffff',
  borderColor: '#2563eb',
  fontWeight: 600,
};

const mono: React.CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace' };

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function FirmwarePublishPage() {
  const [user, setUser] = useState<User | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [boardType, setBoardType] = useState<string>('');
  const [selectedSha, setSelectedSha] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);

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
      setError('');
      try {
        const [bRes, dRes] = await Promise.all([
          authedFetch('/api/firmware/builds'),
          authedFetch('/api/devices'),
        ]);
        const bData = await bRes.json();
        const dData = await dRes.json();
        if (!bRes.ok) throw new Error(bData.error || 'Failed to load builds');
        if (!dRes.ok) throw new Error(dData.error || 'Failed to load devices');
        if (!active) return;
        setBuilds(bData.builds);
        setDevices(dData.devices);
      } catch (e: any) {
        if (active) setError(e?.message || 'Failed');
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [user]);

  // Board-type is the driving filter. Default to whichever board type has the
  // most cameras that could actually receive an OTA -- the one an admin is
  // most likely to want to publish to.
  const boardTypesWithCameras = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of devices) {
      if (!d.boardType) continue;
      counts.set(d.boardType, (counts.get(d.boardType) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [devices]);

  useEffect(() => {
    if (!boardType && boardTypesWithCameras.length > 0) {
      setBoardType(boardTypesWithCameras[0][0]);
    }
  }, [boardType, boardTypesWithCameras]);

  const buildsForBoard = useMemo(
    () => builds.filter((b) => b.boardType === boardType),
    [builds, boardType],
  );

  const camerasForBoard = useMemo(
    () => devices.filter((d) => d.boardType === boardType),
    [devices, boardType],
  );

  const camerasWithoutBoard = useMemo(
    () => devices.filter((d) => !d.boardType),
    [devices],
  );

  // Whenever the board type changes, clear the picker state -- selections from
  // one board type MUST NOT carry over to another (guaranteed brick guard).
  useEffect(() => {
    setSelectedSha('');
    setSelectedIds(new Set());
    setResult(null);
  }, [boardType]);

  function toggleDevice(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllCameras() {
    setSelectedIds(new Set(camerasForBoard.map((d) => d.deviceId)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function publish() {
    if (!selectedSha || selectedIds.size === 0 || !boardType) return;
    if (!confirm(
      `Publish firmware ${selectedSha} to ${selectedIds.size} camera(s)?\n\n` +
      `They will pick up the update on their next timer wake and reboot into the new build. ` +
      `A build that can't reach the cloud automatically falls back to the previous version.`
    )) return;

    setPublishing(true);
    setError('');
    setResult(null);
    try {
      const res = await authedFetch('/api/firmware/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: Array.from(selectedIds),
          buildSha: selectedSha,
          boardType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data as PublishResult);
      // Keep the selection so the admin can see what they picked next to the
      // result, but clear the "select all" of new items.
    } catch (e: any) {
      setError(e?.message || 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  if (!user) {
    return (
      <main style={{ padding: 24 }}>
        <h1 style={{ fontSize: 24 }}>Firmware</h1>
        <p>
          Please <Link href="/login">sign in</Link> with a Louie Labs account.
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Firmware — publish OTA</h1>
        <Link href="/dashboard" style={{ fontSize: 14 }}>← back to dashboard</Link>
      </div>
      <p style={{ opacity: 0.8, marginTop: 0, marginBottom: 20 }}>
        Pick a compiled build, pick the cameras, and hit publish. Each camera
        pulls the update on its next timer wake. See{' '}
        <code style={mono}>docs/FLASH_STORAGE_OTA_PLAN.md</code> for the full
        design.
      </p>

      {error && (
        <div style={{ padding: 12, background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          <b>Error:</b> {error}
        </div>
      )}

      {loading ? (
        <p>Loading builds and cameras…</p>
      ) : (
        <>
          {/* ---- Board type filter ---- */}
          <div style={{ ...cell, marginBottom: 16 }}>
            <label style={{ fontWeight: 600 }}>Board type</label>
            <div style={{ marginTop: 6 }}>
              {boardTypesWithCameras.length === 0 ? (
                <i style={{ opacity: 0.7 }}>
                  No cameras have reported a boardType yet. They will show up
                  here after their next wake with the OTA-ready firmware.
                </i>
              ) : (
                <select
                  value={boardType}
                  onChange={(e) => setBoardType(e.target.value)}
                  style={{ padding: '4px 8px', fontSize: 14 }}
                >
                  {boardTypesWithCameras.map(([bt, n]) => (
                    <option key={bt} value={bt}>
                      {bt} ({n} camera{n === 1 ? '' : 's'})
                    </option>
                  ))}
                </select>
              )}
            </div>
            {camerasWithoutBoard.length > 0 && (
              <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 0 }}>
                {camerasWithoutBoard.length} camera(s) haven&apos;t reported a
                boardType yet — they can&apos;t receive an OTA until they do:{' '}
                <code style={mono}>{camerasWithoutBoard.map((d) => d.deviceId).join(', ')}</code>
              </p>
            )}
          </div>

          {/* ---- Build picker ---- */}
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Build</h2>
          {buildsForBoard.length === 0 ? (
            <div style={{ ...cell, marginBottom: 16 }}>
              <i style={{ opacity: 0.7 }}>
                No compiled builds for <code style={mono}>{boardType || '(no board)'}</code>{' '}
                yet. Push a firmware change to <code style={mono}>main</code>; Cloud Build
                will publish a build here after ~10 min.
              </i>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
              {buildsForBoard.map((b) => (
                <label key={b.sha} style={{ ...cell, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="build"
                    value={b.sha}
                    checked={selectedSha === b.sha}
                    onChange={() => setSelectedSha(b.sha)}
                  />
                  <div style={{ flex: 1 }}>
                    <div>
                      <code style={mono}><b>{b.sha}</b></code>
                      {' — '}{humanBytes(b.sizeBytes)}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      built {timeAgo(b.mtime)}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}

          {/* ---- Camera picker ---- */}
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>
            Cameras
            {camerasForBoard.length > 0 && (
              <span style={{ fontWeight: 400, fontSize: 14, opacity: 0.7, marginLeft: 8 }}>
                ({selectedIds.size} of {camerasForBoard.length} selected)
              </span>
            )}
          </h2>
          {camerasForBoard.length === 0 ? (
            <div style={{ ...cell, marginBottom: 16 }}>
              <i style={{ opacity: 0.7 }}>
                No cameras reporting <code style={mono}>{boardType || '(no board)'}</code>.
              </i>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <button style={btn} onClick={selectAllCameras}>Select all</button>{' '}
                <button style={btn} onClick={clearSelection} disabled={selectedIds.size === 0}>Clear</button>
              </div>
              <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                {camerasForBoard.map((d) => {
                  const on = selectedIds.has(d.deviceId);
                  return (
                    <label key={d.deviceId} style={{ ...cell, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={on} onChange={() => toggleDevice(d.deviceId)} />
                      <div style={{ flex: 1 }}>
                        <div>
                          <b>{d.deviceId}</b>{' '}
                          <span style={{ fontSize: 12, opacity: 0.7 }}>
                            ({d.status}
                            {typeof d.battery === 'number' ? `, ${d.battery}% battery` : ''})
                          </span>
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          on <code style={mono}>{d.firmwareVersion ?? 'unknown'}</code>
                          {d.lastOta && (
                            <>
                              {' · last OTA: '}
                              <code style={mono}>{d.lastOta.result}</code>
                              {' ('}<code style={mono}>{d.lastOta.from}</code>
                              {' → '}<code style={mono}>{d.lastOta.to}</code>{')'}
                            </>
                          )}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {/* ---- Publish ---- */}
          <div style={{ marginTop: 8, marginBottom: 24 }}>
            <button
              style={primaryBtn}
              onClick={publish}
              disabled={publishing || !selectedSha || selectedIds.size === 0}
            >
              {publishing
                ? 'Publishing…'
                : `Publish ${selectedSha ? selectedSha : '(pick a build)'} to ${selectedIds.size} camera${selectedIds.size === 1 ? '' : 's'}`}
            </button>
          </div>

          {/* ---- Result ---- */}
          {result && (
            <div style={{ ...cell, background: '#f0fdf4', borderColor: '#bbf7d0' }}>
              <div>
                <b>Published:</b>{' '}
                <code style={mono}>{result.buildSha}</code> ({humanBytes(result.sizeBytes)})
                {' · sha256 '}
                <code style={mono}>{result.sha256.slice(0, 12)}…</code>
              </div>
              {result.published.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <b>Accepted ({result.published.length}):</b>{' '}
                  <code style={mono}>{result.published.join(', ')}</code>
                </div>
              )}
              {result.errors.length > 0 && (
                <div style={{ marginTop: 6, padding: 8, background: '#fef2f2', borderRadius: 6 }}>
                  <b>Skipped ({result.errors.length}):</b>
                  <ul style={{ margin: '4px 0 0 20px' }}>
                    {result.errors.map((e) => (
                      <li key={e.deviceId}>
                        <code style={mono}>{e.deviceId}</code> — {e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, opacity: 0.8 }}>
                Cameras pick up the OTA on their next timer wake. Their
                results will land in{' '}
                <code style={mono}>state.lastOta</code> once they attempt the
                update.
              </p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
