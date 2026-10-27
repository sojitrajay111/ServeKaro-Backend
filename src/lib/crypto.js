import crypto from 'node:crypto';
import env from '../config/env.js';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Keyed hash for short secrets (PINs, OTPs). A 6-digit code hashed with plain
// bcrypt can be brute-forced from a DB dump; without the server key it can't.
export const hmac = (value) =>
  crypto.createHmac('sha256', env.jwtSecret).update(value).digest('hex');

export const safeEqual = (a, b) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export const randomDigits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
