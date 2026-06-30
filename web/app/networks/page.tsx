'use client';
// Saved-networks "notebook" admin page. Lists every Wi-Fi network that's been
// stashed by a provisioning run (or added here directly), lets an admin reveal
// the password, edit, or delete it. The /provision picker reads from the same
// API, so anything added/edited/deleted here flows into the next provision.
//
// Auth: any signed-in @louielabs.com user (same as /provision and /register).
// All reads/writes go through the auth-gated /api/networks routes; this page
// never touches RTDB directly.

import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';
import type { SavedNetwork, SavedNetworkSummary } from '@/lib/networks';

type RevealCache = Record<string, string>;          // slug -> revealed password

export default function NetworksPage() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  const [list, setList] = useState<SavedNetworkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [revealed, setRevealed] = useState<RevealCache>({});
  const [editing, setEditing] = useState<string | null>(null);    // slug being edited
  const [editPassword, setEditPassword] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [addSsid, setAddSsid] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const authedFetch = useCallback(async (url: string, init: RequestInit = {}) => {
    const token = await user!.getIdToken();
    return fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }, [user]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await authedFetch('/api/networks');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load');
      setList(data.networks || []);
    } catch (e: any) {
      setErr(e?.message || 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user, refresh]);

  async function reveal(slug: string) {
    if (revealed[slug]) {
      // Toggle off.
      const { [slug]: _, ...rest } = revealed;
      setRevealed(rest);
      return;
    }
    try {
      const res = await authedFetch(`/api/networks/${encodeURIComponent(slug)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'reveal failed');
      const net: SavedNetwork = data.network;
      setRevealed((r) => ({ ...r, [slug]: net.password }));
    } catch (e: any) {
      alert(e?.message || 'reveal failed');
    }
  }

  async function startEdit(n: SavedNetworkSummary) {
    setEditing(n.slug);
    setEditNotes(n.notes || '');
    setEditPassword('');     // blank means leave unchanged
  }

  async function saveEdit(slug: string) {
    setBusy(true);
    try {
      const body: any = { notes: editNotes };
      if (editPassword) body.password = editPassword;
      const res = await authedFetch(`/api/networks/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'update failed');
      setEditing(null);
      setEditPassword('');
      setEditNotes('');
      // If we had a revealed password cached, clear it so the user sees the new one fresh.
      const { [slug]: _, ...rest } = revealed;
      setRevealed(rest);
      await refresh();
    } catch (e: any) {
      alert(e?.message || 'update failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(slug: string, ssid: string) {
    if (!confirm(`Delete saved network "${ssid}"?\n\nCameras already provisioned with these credentials keep working — this only removes the notebook entry.`)) return;
    setBusy(true);
    try {
      const res = await authedFetch(`/api/networks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'delete failed');
      await refresh();
    } catch (e: any) {
      alert(e?.message || 'delete failed');
    } finally {
      setBusy(false);
    }
  }

  async function addNetwork() {
    setBusy(true);
    try {
      const res = await authedFetch('/api/networks', {
        method: 'POST',
        body: JSON.stringify({ ssid: addSsid, password: addPassword, notes: addNotes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'create failed');
      setAdding(false);
      setAddSsid('');
      setAddPassword('');
      setAddNotes('');
      await refresh();
    } catch (e: any) {
      alert(e?.message || 'create failed');
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '40px auto', padding: 16 }}>
        <h2>Saved Wi-Fi networks</h2>
        <p>Please <a href="/login">sign in</a> with your @louielabs.com account first.</p>
      </main>
    );
  }

  const field: React.CSSProperties = { display: 'block', width: '100%', padding: 8, margin: '4px 0 12px', boxSizing: 'border-box' };
  const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #eee', verticalAlign: 'top', fontSize: 14 };
  const btn: React.CSSProperties = { padding: '6px 10px', fontSize: 13, cursor: 'pointer' };

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 820, margin: '40px auto', padding: 16 }}>
      <h2 style={{ marginBottom: 4 }}>Saved Wi-Fi networks</h2>
      <p style={{ color: '#555', marginTop: 0 }}>
        The "shared notebook" of Wi-Fi credentials the <a href="/provision">Set up a camera</a> picker
        reads from. Stored in the project's database, never on student laptops.
      </p>

      {err && <p style={{ color: '#c0392b' }}>{err}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0' }}>
        <div style={{ color: '#666', fontSize: 13 }}>
          {loading ? 'Loading…' : `${list.length} saved network${list.length === 1 ? '' : 's'}`}
        </div>
        {!adding && (
          <button style={{ ...btn, padding: '8px 14px', fontWeight: 600 }} onClick={() => setAdding(true)}>
            + Add network
          </button>
        )}
      </div>

      {adding && (
        <div style={{ padding: 12, background: '#f5f7fb', border: '1px solid #dbe1ec', borderRadius: 8, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Add a saved network</h3>
          <label>Network name (SSID)</label>
          <input style={field} value={addSsid} onChange={(e) => setAddSsid(e.target.value)} placeholder="School-Wifi" />
          <label>Password</label>
          <input style={field} value={addPassword} onChange={(e) => setAddPassword(e.target.value)} placeholder="8–63 characters (WPA2)" />
          <label>Notes (optional)</label>
          <input style={field} value={addNotes} onChange={(e) => setAddNotes(e.target.value)} placeholder="e.g. school cafeteria 2.4 GHz" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...btn, fontWeight: 600 }} disabled={busy || !addSsid || addPassword.length < 8} onClick={addNetwork}>
              {busy ? 'Saving…' : 'Save network'}
            </button>
            <button style={btn} disabled={busy} onClick={() => { setAdding(false); setAddSsid(''); setAddPassword(''); setAddNotes(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr style={{ background: '#f5f7fb', textAlign: 'left' }}>
            <th style={cell}>Network (SSID)</th>
            <th style={cell}>Password</th>
            <th style={cell}>Notes</th>
            <th style={cell}>Updated</th>
            <th style={cell}></th>
          </tr>
        </thead>
        <tbody>
          {list.map((n) => {
            const isEditing = editing === n.slug;
            const isRevealed = Boolean(revealed[n.slug]);
            return (
              <tr key={n.slug}>
                <td style={cell}>
                  <div style={{ fontWeight: 600 }}>{n.ssid}</div>
                  <div style={{ color: '#888', fontSize: 12 }}>slug: <code>{n.slug}</code></div>
                </td>
                <td style={cell}>
                  {isEditing ? (
                    <input
                      style={{ ...field, margin: 0 }}
                      value={editPassword}
                      onChange={(e) => setEditPassword(e.target.value)}
                      placeholder="(leave blank to keep current)"
                    />
                  ) : (
                    <>
                      <code style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>
                        {isRevealed ? revealed[n.slug] : '••••••••'}
                      </code>
                      <button style={{ ...btn, marginLeft: 8 }} onClick={() => reveal(n.slug)}>
                        {isRevealed ? 'Hide' : 'Reveal'}
                      </button>
                    </>
                  )}
                </td>
                <td style={cell}>
                  {isEditing ? (
                    <input
                      style={{ ...field, margin: 0 }}
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                    />
                  ) : (
                    n.notes ? <span>{n.notes}</span> : <span style={{ color: '#aaa' }}>—</span>
                  )}
                </td>
                <td style={cell}>
                  <div style={{ fontSize: 13 }}>{new Date(n.updatedAt).toLocaleString()}</div>
                  <div style={{ color: '#888', fontSize: 12 }}>{n.updatedBy}</div>
                </td>
                <td style={cell}>
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={{ ...btn, fontWeight: 600 }} disabled={busy} onClick={() => saveEdit(n.slug)}>Save</button>
                      <button style={btn} disabled={busy} onClick={() => { setEditing(null); setEditPassword(''); setEditNotes(''); }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={btn} disabled={busy} onClick={() => startEdit(n)}>Edit</button>
                      <button style={{ ...btn, color: '#c0392b' }} disabled={busy} onClick={() => remove(n.slug, n.ssid)}>Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {!loading && list.length === 0 && (
            <tr><td style={{ ...cell, color: '#888', textAlign: 'center', padding: 24 }} colSpan={5}>
              No saved networks yet. Add one above, or save the next network you use from the <a href="/provision">Set up a camera</a> page.
            </td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
