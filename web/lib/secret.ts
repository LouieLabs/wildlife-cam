// Generates the per-device shared secret.
//
// Project decision: cryptographically random, stored in CLEAR so a student can
// look it up again if they lose it. It is RANDOM per device (NOT derived from
// the MAC), so knowing a camera's MAC tells an attacker nothing about its
// secret.
//
// Format: 10 random chars from A-Z + 0-9 (~51 bits), grouped 3-3-4 with dashes
// for readability, like a phone number -> e.g. "A7K-2Q4-9XYZ". The dashes are
// PART of the literal secret (stored, flashed into secrets.h, and compared
// as-is); they add no entropy but make it easy to read and copy. The only
// feasible attack is online guessing against the database, which 51 bits
// defeats with a huge margin.
import { randomInt } from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateDeviceSecret(): string {
  const group = (n: number) =>
    Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group(3)}-${group(3)}-${group(4)}`;
}
