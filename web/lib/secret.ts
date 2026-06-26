// Generates the per-device shared secret.
//
// Project decision (high-school project): 6 characters, A-Z + 0-9, generated
// with a cryptographically secure random source and stored in CLEAR so a
// student can look it up again if they lose it. It is RANDOM per device (NOT
// derived from the MAC address), so knowing a camera's MAC tells an attacker
// nothing about its secret.
import { randomInt } from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateDeviceSecret(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
