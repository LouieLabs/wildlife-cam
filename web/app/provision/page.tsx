'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

// "Set up a camera" — Web Serial provisioning (Phase 3, route b).
// Assumes the board is ALREADY flashed with the provisioning firmware. The page
// resets the board over USB to catch its cold-boot provisioning window, reads
// the MAC, registers the device (mints a secret), then writes the chosen
// network(s) + identity to the board's NVS. Chrome/Edge desktop only (Web Serial).

type Mode = 'wifi' | 'halow' | 'both';

export default function ProvisionPage() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  const [deviceId, setDeviceId] = useState('');
  const [mode, setMode] = useState<Mode>('both');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [halowSsid, setHalowSsid] = useState('');
  const [halowPsk, setHalowPsk] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ mac: string; deviceId: string; secret: string } | null>(null);

  const append = (line: string) => setLog((l) => [...l, line]);
  const wantWifi = mode === 'wifi' || mode === 'both';
  const wantHalow = mode === 'halow' || mode === 'both';

  async function authedFetch(url: string, init: RequestInit = {}) {
    const token = await user!.getIdToken();
    return fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  async function provision() {
    setResult(null);
    setLog([]);
    setBusy(true);
    let port: any = null;
    try {
      const id = deviceId.toLowerCase().trim();
      if (!/^[a-z0-9_-]{3,40}$/.test(id)) throw new Error('Device ID must be 3–40 chars: a–z, 0–9, _ or -');
      if (wantWifi && !wifiSsid) throw new Error('Enter the 2.4 GHz network name');
      if (wantHalow && !halowSsid) throw new Error('Enter the HaLow network name');

      const serial = (navigator as any).serial;
      if (!serial) throw new Error('Web Serial not available — use Chrome or Edge on desktop.');

      append('Pick the camera’s USB serial port…');
      port = await serial.requestPort();
      await port.open({ baudRate: 115200 });

      const reader = port.readable.getReader();
      const writer = port.writable.getWriter();
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // One continuous pump owns reader.read(); readLine() polls the buffer.
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) buf += dec.decode(value);
          }
        } catch { /* cancelled on close */ }
      })();

      async function readLine(timeoutMs: number): Promise<string> {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const nl = buf.indexOf('\n');
          if (nl >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            return line;
          }
          await sleep(20);
        }
        return '';
      }
      async function send(cmd: string) {
        append('> ' + cmd);
        await writer.write(enc.encode(cmd + '\n'));
      }
      // Wait for a line starting with `prefix`; returns it. Logs printable lines.
      async function expect(prefix: string, timeoutMs: number): Promise<string> {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const line = await readLine(Math.max(200, end - Date.now()));
          if (line && /[\x20-\x7e]/.test(line)) append('< ' + line);
          if (line.startsWith(prefix)) return line;
        }
        throw new Error(`Timed out waiting for "${prefix}"`);
      }

      // Reset into RUN mode (RTS->EN pulse, DTR low so GPIO0 stays high) to catch
      // the cold-boot provisioning window.
      append('Resetting the camera…');
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(120);
      await port.setSignals({ requestToSend: false });

      await expect('[prov] ready', 8000);
      await send('MAC?');
      const macLine = await expect('MAC ', 4000);
      const mac = macLine.slice(4).trim();
      append('Camera MAC: ' + mac);

      append('Registering on the dashboard…');
      const res = await authedFetch('/api/register-device', {
        method: 'POST',
        body: JSON.stringify({ deviceId: id, mac: mac.replace(/[^0-9a-fA-F]/g, '') }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'register-device failed');
      const secret: string = data.secret;
      append('Secret minted ✓');

      if (wantWifi) {
        await send('SET wifi_ssid ' + wifiSsid); await expect('OK', 3000);
        await send('SET wifi_pass ' + wifiPass); await expect('OK', 3000);
      }
      if (wantHalow) {
        await send('SET halow_ssid ' + halowSsid); await expect('OK', 3000);
        await send('SET halow_psk ' + halowPsk); await expect('OK', 3000);
      }
      await send('SET mode ' + mode); await expect('OK', 3000);
      await send('SET id ' + id); await expect('OK', 3000);
      await send('SET secret ' + secret); await expect('OK', 3000);
      await send('SAVE'); await expect('SAVED', 5000);

      append('Done ✓ — camera provisioned and rebooting.');
      setResult({ mac, deviceId: id, secret });

      try { await reader.cancel(); } catch {}
      try { writer.releaseLock(); } catch {}
      await port.close();
    } catch (e: any) {
      append('ERROR: ' + (e?.message || String(e)));
      try { if (port) await port.close(); } catch {}
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '40px auto', padding: 16 }}>
        <h2>Set up a camera</h2>
        <p>Please <a href="/login">sign in</a> with your @louielabs.com account first.</p>
      </main>
    );
  }

  const field = { display: 'block', width: '100%', padding: 8, margin: '4px 0 12px', boxSizing: 'border-box' as const };

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '40px auto', padding: 16 }}>
      <h2>Set up a camera</h2>
      <p style={{ color: '#555' }}>
        Plug the (already-flashed) camera into this computer over USB, fill in the network details,
        then click <b>Provision camera</b>. Chrome or Edge on desktop only.
      </p>

      <label>Camera name (device ID)</label>
      <input style={field} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="pond_cam_02" />

      <label>Which radio(s)?</label>
      <select style={field} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        <option value="both">Both (HaLow preferred, 2.4 GHz fallback)</option>
        <option value="halow">HaLow only</option>
        <option value="wifi">2.4 GHz Wi-Fi only</option>
      </select>

      {wantHalow && (
        <>
          <label>HaLow network name</label>
          <input style={field} value={halowSsid} onChange={(e) => setHalowSsid(e.target.value)} placeholder="critterwatch-halow" />
          <label>HaLow password (PSK)</label>
          <input style={field} value={halowPsk} onChange={(e) => setHalowPsk(e.target.value)} />
        </>
      )}
      {wantWifi && (
        <>
          <label>2.4 GHz network name</label>
          <input style={field} value={wifiSsid} onChange={(e) => setWifiSsid(e.target.value)} />
          <label>2.4 GHz password</label>
          <input style={field} value={wifiPass} onChange={(e) => setWifiPass(e.target.value)} />
        </>
      )}

      <button onClick={provision} disabled={busy} style={{ padding: '10px 16px', fontWeight: 600 }}>
        {busy ? 'Provisioning…' : 'Provision camera'}
      </button>

      {result && (
        <div style={{ marginTop: 16, padding: 12, background: '#eef9ee', border: '1px solid #bcdcbc', borderRadius: 8 }}>
          <b>✓ {result.deviceId} is set up.</b>
          <div style={{ fontSize: 13, marginTop: 6 }}>MAC <code>{result.mac}</code> · secret <code>{result.secret}</code></div>
          <div style={{ fontSize: 12, color: '#555' }}>Label the board with its name so you know which camera it is.</div>
        </div>
      )}

      {log.length > 0 && (
        <pre style={{ marginTop: 16, padding: 12, background: '#111', color: '#0f0', fontSize: 12, borderRadius: 8, maxHeight: 240, overflow: 'auto' }}>
          {log.join('\n')}
        </pre>
      )}
    </main>
  );
}
