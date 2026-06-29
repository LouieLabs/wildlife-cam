// Shared test plumbing for the route tests.
//
// Each route file is independent — vi.mock is per-file and hoisted — so we
// can't share "the mocks" themselves. What we CAN share is the tiny stuff:
// request builders and a canned authenticated user shape. That's all this is.

import type { NextRequest } from 'next/server';

// Build a Web fetch Request and cast to NextRequest. The handlers only touch
// the parts of NextRequest that exist on the base Request (headers, json, url),
// so this works without pulling in Next's runtime.
export function makeRequest(opts: {
  method?: 'GET' | 'POST';
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
} = {}): NextRequest {
  const method = opts.method ?? 'GET';
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(opts.url ?? 'http://localhost/api/test', init) as unknown as NextRequest;
}

export const FAKE_USER = { uid: 'fake-uid-123', email: 'student@louielabs.com' };
