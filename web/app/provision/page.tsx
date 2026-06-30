'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';
import type { SavedNetworkSummary } from '@/lib/networks';

// "Set up a camera" — Web Serial provisioning (Phase 3, route b).
// Assumes the board is ALREADY flashed with the provisioning firmware. The page
// resets the board over USB to catch its cold-boot provisioning window, reads
// the MAC, registers the device (mints a secret), then writes the chosen
// network(s) + identity to the board's NVS. Chrome/Edge desktop only (Web Serial).

type Mode = 'wifi' | 'halow' | 'both';

export default function ProvisionPage() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  // Load the ESP Web Tools web component (provides <esp-web-install-button>).
  useEffect(() => {
    if (document.getElementById('esp-web-tools')) return;
    const s = document.createElement('script');
    s.id = 'esp-web-tools';
    s.type = 'module';
    s.src = 'https://unpkg.com/esp-web-tools@10/dist/web/install-button.js';
    document.body.appendChild(s);
  }, []);

  // When flashing finishes, scroll the user down to Step 2 (same page).
  useEffect(() => {
    const el = document.querySelector('esp-web-install-button');
    if (!el) return;
    const onState = (e: any) => {
      if (String(e?.detail?.state || '').toLowerCase() === 'finished') {
        document.getElementById('step2')?.scrollIntoView({ behavior: 'smooth' });
      }
    };
    el.addEventListener('state-changed', onState);
    return () => el.removeEventListener('state-changed', onState);
  }, []);

  const [deviceId, setDeviceId] = useState('');
  const [mode, setMode] = useState<Mode>('both');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [halowSsid, setHalowSsid] = useState('');
  const [halowPsk, setHalowPsk] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ mac: string; deviceId: string; secret: string } | null>(null);

  // Saved-networks "shared notebook": load on sign-in and let the user pick one
  // instead of retyping the password. If any exist we default to "saved" (most-
  // recently-updated) so onboarding the next board in a known network is one
  // click. If none exist we default to "new" so the first provision seeds the
  // notebook. "oneoff" is for a one-time test network we don't want saved.
  type WifiSource = 'saved' | 'new' | 'oneoff';
  const [savedNetworks, setSavedNetworks] = useState<SavedNetworkSummary[]>([]);
  const [wifiSource, setWifiSource] = useState<WifiSource>('new');
  const [savedSlug, setSavedSlug] = useState<string>('');
  const [saveNewWifi, setSaveNewWifi] = useState(true);

  const append = (line: string) => setLog((l) => [...l, line]);
  const wantWifi = mode === 'wifi' || mode === 'both';
  const wantHalow = mode === 'halow' || mode === 'both';

  // --- field rules (shown under each box; block submit) ----------------------
  const ssidOk = (s: string) => s.length >= 1 && s.length <= 32;          // WPA SSID
  const wpaOk = (s: string) => s.length >= 8 && s.length <= 63;           // WPA2 passphrase
  const halowPskOk = (s: string) => wpaOk(s) || /^[0-9a-fA-F]{64}$/.test(s); // or 64-hex key
  const idOk = /^[A-Za-z0-9_-]{3,40}$/.test(deviceId.trim());

  const idErr = deviceId.length > 0 && !idOk ? '3–40 characters: A–Z, a–z, 0–9, _ or -' : '';
  const wifiSsidErr = wifiSsid.length > 0 && !ssidOk(wifiSsid) ? 'Too long (max 32 characters)' : '';
  const wifiPassErr = wifiPass.length > 0 && !wpaOk(wifiPass) ? 'Must be 8–63 characters' : '';
  const halowSsidErr = halowSsid.length > 0 && !ssidOk(halowSsid) ? 'Too long (max 32 characters)' : '';
  const halowPskErr = halowPsk.length > 0 && !halowPskOk(halowPsk) ? 'Use 8–63 characters, or a 64-char hex key' : '';

  // Wi-Fi inputs valid in 3 ways: pick a saved one, or type a new/oneoff one.
  const wifiInputsOk = wifiSource === 'saved'
    ? Boolean(savedSlug)
    : (ssidOk(wifiSsid) && wpaOk(wifiPass));
  const canSubmit = !busy && idOk
    && (!wantWifi || wifiInputsOk)
    && (!wantHalow || (ssidOk(halowSsid) && halowPskOk(halowPsk)));

  // Requirement in gray; turns red with the error message when input is invalid.
  const hint = (req: string, err: string) => (
    <small style={{ display: 'block', marginTop: -8, marginBottom: 12, color: err ? '#c0392b' : '#888' }}>
      {err || req}
    </small>
  );

  async function authedFetch(url: string, init: RequestInit = {}) {
    const token = await user!.getIdToken();
    return fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  // Load the saved-networks notebook once we know who's signed in. Default
  // wifiSource to "saved" with the freshest network if any exist, so the
  // common case (provisioning another camera on the same Wi-Fi) is one click.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const res = await authedFetch('/api/networks');
        if (!res.ok) return;
        const data = await res.json();
        const list: SavedNetworkSummary[] = data.networks || [];
        setSavedNetworks(list);
        if (list.length > 0) {
          setWifiSource('saved');
          setSavedSlug(list[0].slug);   // API sorts by updatedAt desc
        }
      } catch { /* networks API offline -> fall back to typing inputs */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function provision() {
    setResult(null);
    setLog([]);
    setBusy(true);
    let port: any = null;
    try {
      const id = deviceId.trim();
      if (!idOk) throw new Error('Camera name must be 3–40 chars: A–Z, a–z, 0–9, _ or -');
      if (wantHalow && !ssidOk(halowSsid)) throw new Error('HaLow network name must be 1–32 characters');
      if (wantHalow && !halowPskOk(halowPsk)) throw new Error('HaLow password must be 8–63 characters or a 64-char hex key');

      // Resolve the Wi-Fi creds we'll actually push to the board: either fetch
      // them from the saved-networks notebook (picker mode) or take what's in
      // the input boxes. The password only ever leaves the API for the brief
      // moment we hand it to Web Serial -- never displayed.
      let effectiveWifiSsid = wifiSsid;
      let effectiveWifiPass = wifiPass;
      if (wantWifi && wifiSource === 'saved') {
        if (!savedSlug) throw new Error('Pick a saved network or switch to "+ New network"');
        append('Loading saved Wi-Fi credentials…');
        const res = await authedFetch(`/api/networks/${encodeURIComponent(savedSlug)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'failed to load saved network');
        effectiveWifiSsid = data.network.ssid;
        effectiveWifiPass = data.network.password;
      }
      if (wantWifi && !ssidOk(effectiveWifiSsid)) throw new Error('2.4 GHz network name must be 1–32 characters');
      if (wantWifi && !wpaOk(effectiveWifiPass)) throw new Error('2.4 GHz password must be 8–63 characters');

      const serial = (navigator as any).serial;
      if (!serial) throw new Error('Web Serial not available — use Chrome or Edge browsers on desktop.');

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
        await send('SET wifi_ssid ' + effectiveWifiSsid); await expect('OK', 3000);
        await send('SET wifi_pass ' + effectiveWifiPass); await expect('OK', 3000);
      }
      if (wantHalow) {
        await send('SET halow_ssid ' + halowSsid); await expect('OK', 3000);
        await send('SET halow_psk ' + halowPsk); await expect('OK', 3000);
      }
      await send('SET mode ' + mode); await expect('OK', 3000);
      await send('SET id ' + id); await expect('OK', 3000);
      await send('SET secret ' + secret); await expect('OK', 3000);
      // SAVE triggers an immediate reboot, which can garble the "SAVED" reply.
      // Accept a clean SAVED, or the reboot/config banner, as success; "ERR" =
      // the camera rejected it.
      await send('SAVE');
      {
        const end = Date.now() + 7000;
        let ok = false;
        while (Date.now() < end) {
          const line = await readLine(Math.max(200, end - Date.now()));
          if (line && /[\x20-\x7e]/.test(line)) append('< ' + line);
          if (line.startsWith('SAVED') || line.includes('ESP-ROM') || line.startsWith('[config]')) { ok = true; break; }
          if (line.startsWith('ERR')) throw new Error('Camera rejected SAVE: ' + line);
        }
        if (!ok) throw new Error('Timed out confirming save');
      }

      append('Done ✓ — camera provisioned and rebooting.');
      setResult({ mac, deviceId: id, secret });

      // If the user typed a new network with "Save this network" on, write it
      // to the notebook AFTER the board's confirmed up -- so we don't pollute
      // the notebook with a credential that turned out to be wrong. Failure
      // here is non-fatal: the board is already provisioned.
      if (wantWifi && wifiSource === 'new' && saveNewWifi) {
        try {
          const res = await authedFetch('/api/networks', {
            method: 'POST',
            body: JSON.stringify({ ssid: wifiSsid, password: wifiPass }),
          });
          if (res.ok) {
            append('Saved "' + wifiSsid + '" to the network notebook ✓');
          } else if (res.status === 409) {
            append('"' + wifiSsid + '" already saved (left existing record untouched).');
          } else {
            const data = await res.json().catch(() => ({}));
            append('Could not save network: ' + (data.error || res.status));
          }
        } catch (e: any) {
          append('Could not save network: ' + (e?.message || e));
        }
      }

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
  // ESP Web Tools custom element (typed as any so TSX accepts the unknown tag).
  const EspInstall = 'esp-web-install-button' as any;

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '40px auto', padding: 16 }}>
      <h2>Set up a camera</h2>
      <p style={{ color: '#555' }}>
        Plug the camera into this computer over USB. Two steps: install the firmware
        (only the first time for a board), then enter its network details. Chrome
        or Edge browsers on desktop only.
      </p>

      <h3 style={{ marginBottom: 2 }}>Step 1 — Install the firmware</h3>
      <p style={{ color: '#555', marginTop: 0, fontSize: 14 }}>
        New or blank board? Install it once. Already installed? Skip to Step 2.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <EspInstall manifest="/firmware/manifest.json">
          <button slot="activate" style={{ padding: '10px 16px', fontWeight: 600 }}>Install firmware</button>
          <span slot="unsupported">Your browser can’t install — use Chrome or Edge browsers on desktop.</span>
          <span slot="not-allowed">Installing needs a secure page (https or localhost).</span>
        </EspInstall>
        <span style={{ fontSize: 13, color: '#555' }}>
          In the pop-up, select the line with <code>cu.usbserial</code> (or similar) in it.
        </span>
      </div>

      <hr style={{ margin: '20px 0' }} />

      <h3 id="step2" style={{ marginBottom: 8 }}>Step 2 — Enter the camera’s network details (after successful Step 1 install)</h3>
      <label>Camera name (device ID)</label>
      <input style={field} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="pond_cam_02" />
      {hint('3–40 characters: A–Z, a–z, 0–9, _ or -', idErr)}

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
          {hint('1–32 characters', halowSsidErr)}
          <label>HaLow password (PSK)</label>
          <input style={field} value={halowPsk} onChange={(e) => setHalowPsk(e.target.value)} />
          {hint('8–63 characters, or a 64-character hex key', halowPskErr)}
        </>
      )}
      {wantWifi && (
        <>
          <label>2.4 GHz Wi-Fi network</label>
          <select
            style={field}
            value={wifiSource === 'saved' ? `saved:${savedSlug}` : wifiSource}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('saved:')) {
                setWifiSource('saved');
                setSavedSlug(v.slice('saved:'.length));
              } else {
                setWifiSource(v as WifiSource);
              }
            }}
          >
            {savedNetworks.map((n) => (
              <option key={n.slug} value={`saved:${n.slug}`}>
                {n.ssid} (saved)
              </option>
            ))}
            <option value="new">+ New network (save for future cameras)</option>
            <option value="oneoff">+ One-off (don’t save)</option>
          </select>
          <small style={{ display: 'block', marginTop: -8, marginBottom: 12, color: '#888' }}>
            {savedNetworks.length === 0
              ? 'No saved networks yet — pick "+ New" to add one.'
              : <>Manage saved networks on the <a href="/networks">Networks</a> page.</>}
          </small>

          {wifiSource === 'saved' ? (
            <div style={{ padding: 10, background: '#f5f7fb', border: '1px solid #dbe1ec', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#555' }}>
              Will use the saved password for <b>{savedNetworks.find((n) => n.slug === savedSlug)?.ssid || savedSlug}</b>. The student never sees it.
            </div>
          ) : (
            <>
              <label>2.4 GHz network name</label>
              <input style={field} value={wifiSsid} onChange={(e) => setWifiSsid(e.target.value)} />
              {hint('1–32 characters', wifiSsidErr)}
              <label>2.4 GHz password</label>
              <input style={field} value={wifiPass} onChange={(e) => setWifiPass(e.target.value)} />
              {hint('8–63 characters (WPA2)', wifiPassErr)}
              {wifiSource === 'new' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -4, marginBottom: 12, fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={saveNewWifi}
                    onChange={(e) => setSaveNewWifi(e.target.checked)}
                  />
                  Save this network for future cameras
                </label>
              )}
            </>
          )}
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={provision} disabled={!canSubmit} style={{ padding: '10px 16px', fontWeight: 600, flexShrink: 0 }}>
          {busy ? 'Provisioning…' : 'Provision camera'}
        </button>
        <span style={{ fontSize: 13, color: '#555' }}>
          In the pop-up, select the line with <code>cu.usbserial</code> (or similar) in it.
        </span>
      </div>

      {result && (
        <div style={{ marginTop: 16, padding: 12, background: '#eef9ee', border: '1px solid #bcdcbc', borderRadius: 8 }}>
          <b>✓ {result.deviceId} is set up.</b>
          <div style={{ marginTop: 6 }}>Label the board with <b>{result.deviceId}</b> so you know which camera it is.</div>
          <div style={{ fontSize: 13, marginTop: 6, color: '#555' }}>MAC <code>{result.mac}</code> · secret <code>{result.secret}</code></div>
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
