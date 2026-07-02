// Server-side auth guard for camera-facing API routes.
//
// Before: every camera shared one global CAMERA_API_KEY env var. If any board
// leaked the key, every board had to be re-flashed.
// Now: each board has its OWN secret, minted at registration and stored under
// /pre_shared_keys/{deviceId} in the Realtime Database. The board sends its
// secret in the `x-device-secret` header; we look up the expected value for
// that deviceId and compare with a constant-time check.
//
// The deviceId must be passed in by the route (it usually already parses it
// out of the request body for its own work, so we don't double-read here).
import { timingSafeEqual } from 'crypto';
import { rtdbGet } from './rtdb';
import { HttpError } from './requireLouieLabsUser';

// Constant-time string compare. Always reads both buffers to avoid leaking
// length info either: returns false on a length mismatch only after running the
// equal-length compare on a dummy.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // burn ~same time as a real compare so an attacker can't time-probe length
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// Throws HttpError on any auth failure. Returns void on success.
// Validates deviceId shape too -- callers can rely on the id being well-formed
// after this returns.
export async function requireDeviceSecret(req: Request, deviceId: string): Promise<void> {
  // Case is preserved end-to-end (LL-cam1 stays LL-cam1) so the RTDB lookup
  // matches the path the register route wrote to. Pattern matches register-device.
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
    throw new HttpError(400, 'Invalid device ID');
  }
  const presented = req.headers.get('x-device-secret') || '';
  if (!presented) throw new HttpError(401, 'Missing device secret');

  const expected = await rtdbGet<string>(`pre_shared_keys/${deviceId}`);
  // Unknown device, or registered with no secret -- treat both as unauthorized.
  // Still run safeEqual against a dummy to keep timing flat across the two
  // failure modes (unknown device vs wrong secret).
  if (!expected) {
    safeEqual(presented, presented);
    throw new HttpError(401, 'Unauthorized device');
  }
  if (!safeEqual(presented, expected)) {
    throw new HttpError(401, 'Unauthorized device');
  }
}
