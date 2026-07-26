// Client for the private SpeciesNet Cloud Run service (speciesnet-service/).
//
// In plain words: this is the phone line to the model that identifies animals.
// We send it a photo; it answers "is there an animal here, where is it, and
// what species?". The model runs as our own private Cloud Run service.
//
// Auth (why there is STILL no API key): the service only accepts callers that
// Cloud Run's own IAM layer recognizes. We prove who we are with a short-lived
// Google-signed ID token minted from the same keyless service-account
// credentials (ADC) the rest of this backend already uses — same pattern as
// rtdb.ts, except Cloud Run wants an OIDC *identity* token (aud = the service
// URL) rather than an OAuth *access* token, so we go through getIdTokenClient.
//
// Feature switch: SPECIESNET_SERVICE_URL unset/empty = OFF. Analysis then does
// not run at all and captures stay pending until the service is deployed.

import { GoogleAuth } from 'google-auth-library';

const SERVICE_URL = process.env.SPECIESNET_SERVICE_URL || '';
// Warm calls take ~2-5 s; a COLD instance can take ~40-60 s to load the model.
// We'd rather time out and leave one photo pending than hold a whole batch
// hostage — the next tick hits the now-warm service.
const TIMEOUT_MS = Number(process.env.SPECIESNET_TIMEOUT_MS ?? '20000');

const auth = new GoogleAuth(); // module-level singleton, keyless ADC

export type SpeciesNetCategory = 'animal' | 'person' | 'vehicle';

export type SpeciesNetDetection = {
  category: SpeciesNetCategory;
  label: string | null;   // species common name ("mule deer"), null if unknown
  confidence: number;     // 0..1
  box: number[];          // [x, y, w, h] PIXELS, top-left origin (dashboard-native)
  boxNorm: number[];      // [x, y, w, h] normalized 0..1 (resolution-independent)
};

export type SpeciesNetResult = {
  modelVersion: string;
  detections: SpeciesNetDetection[];
};

// The injectable seam: analyzeCaptures (and its tests) only ever see this
// shape, so tests can pass a fake and never touch the network.
export type SpeciesNetClient = { detect(jpeg: Buffer): Promise<SpeciesNetResult> };

export function isSpeciesNetEnabled(): boolean {
  return SERVICE_URL !== '';
}

// Cloud Run rejects tokens whose audience isn't the service's base URL, so the
// audience is the URL without the /detect path.
async function mintIdToken(audience: string): Promise<string> {
  const client = await auth.getIdTokenClient(audience);
  // google-auth-library v9 returns a plain object; v10 returns a Headers
  // instance — handle both so a transitive major bump can't break auth.
  const headers: any = await client.getRequestHeaders(audience);
  const bearer =
    typeof headers?.get === 'function' ? headers.get('Authorization') : headers?.Authorization;
  if (!bearer) throw new Error('could not mint an ID token for the SpeciesNet service');
  return String(bearer).replace(/^Bearer /, '');
}

const CATEGORIES: SpeciesNetCategory[] = ['animal', 'person', 'vehicle'];

// Keep only well-formed detections; anything malformed is dropped rather than
// crashing the pipeline (the caller treats a throw as "service down").
function sanitizeResult(raw: any): SpeciesNetResult {
  const detections: SpeciesNetDetection[] = [];
  if (raw && Array.isArray(raw.detections)) {
    for (const d of raw.detections) {
      if (!d || !CATEGORIES.includes(d.category)) continue;
      if (typeof d.confidence !== 'number') continue;
      const box =
        Array.isArray(d.box) && d.box.length === 4 && d.box.every((n: any) => typeof n === 'number')
          ? d.box
          : null;
      if (!box) continue;
      const boxNorm =
        Array.isArray(d.boxNorm) && d.boxNorm.length === 4 && d.boxNorm.every((n: any) => typeof n === 'number')
          ? d.boxNorm
          : null;
      detections.push({
        category: d.category,
        label: typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 80) : null,
        confidence: Math.min(1, Math.max(0, d.confidence)),
        box,
        boxNorm: boxNorm ?? box.map(() => 0),
      });
    }
  }
  return {
    modelVersion: typeof raw?.modelVersion === 'string' ? raw.modelVersion : 'unknown',
    detections,
  };
}

export function createSpeciesNetClient(opts?: {
  url?: string;
  fetchImpl?: typeof fetch;
  getToken?: (audience: string) => Promise<string>;
  timeoutMs?: number;
}): SpeciesNetClient {
  const url = opts?.url ?? SERVICE_URL;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const getToken = opts?.getToken ?? mintIdToken;
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;

  return {
    async detect(jpeg: Buffer): Promise<SpeciesNetResult> {
      if (!url) throw new Error('SPECIESNET_SERVICE_URL is not set');
      const token = await getToken(url);
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/detect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/jpeg',
        },
        body: new Uint8Array(jpeg),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`SpeciesNet service returned ${res.status}`);
      return sanitizeResult(await res.json());
    },
  };
}

let defaultClient: SpeciesNetClient | null = null;
export function getDefaultSpeciesNetClient(): SpeciesNetClient {
  return (defaultClient ??= createSpeciesNetClient());
}
