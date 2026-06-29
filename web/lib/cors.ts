// CORS allowlist for browser routes called from off-host.
//
// Used by /api/captures, which serves wildwatch-cam-viewer (and any future
// Firebase Hosting site under the louielabs project). The Cloud Run service is
// at a different origin than the gallery, so the browser needs CORS headers.
//
// Pattern allowed:
//   - http://localhost:5173                       (Vite dev)
//   - https://wildwatch-cam-viewer.web.app        (live site)
//   - https://wildwatch-cam-viewer--*.web.app     (preview channels per branch)
//
// Add new origins here when a new gallery site or admin tool comes online.

const EXACT_ALLOWED = new Set<string>([
  "http://localhost:5173",
  "http://localhost:3000",
  "https://wildwatch-cam-viewer.web.app",
  "https://wildwatch-cam-viewer.firebaseapp.com",
]);

const PATTERN_ALLOWED: RegExp[] = [
  // Firebase Hosting preview channels: <site>--<channel>-<hash>.web.app
  /^https:\/\/wildwatch-cam-viewer--[a-z0-9-]+\.web\.app$/,
];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (EXACT_ALLOWED.has(origin)) return true;
  return PATTERN_ALLOWED.some((re) => re.test(origin));
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "3600",
    Vary: "Origin",
  };
}
