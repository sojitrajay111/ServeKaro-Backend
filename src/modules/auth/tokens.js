import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import { Session } from './model.js';
import { randomToken, sha256, safeEqual } from '../../lib/crypto.js';
import { unauthenticated } from '../../lib/errors.js';

const REFRESH_DAYS = 30;
export const REFRESH_COOKIE = 'sk_rt';

const cookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: env.isProd ? 'none' : 'lax',
  path: '/api/v1/auth',
  maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
};

export const signAccessToken = (user) =>
  jwt.sign({ sub: String(user._id), rid: String(user.restaurantId), ver: user.tokenVersion }, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });

// Signed short-lived tokens for links (email verify, staff invite).
export const signPurposeToken = (purpose, sub, expiresIn) =>
  jwt.sign({ purpose, sub: String(sub) }, env.jwtRefreshSecret, { algorithm: 'HS256', expiresIn });

export function verifyPurposeToken(token, purpose) {
  try {
    const p = jwt.verify(token, env.jwtRefreshSecret, { algorithms: ['HS256'] });
    if (p.purpose !== purpose) throw new Error('wrong purpose');
    return p;
  } catch {
    throw unauthenticated('This link is invalid or has expired');
  }
}

async function createSession(req, user, family = randomToken(16)) {
  const secret = randomToken(32);
  const session = await Session.create({
    userId: user._id,
    family,
    tokenHash: sha256(secret),
    expiresAt: new Date(Date.now() + REFRESH_DAYS * 864e5),
    userAgent: req.get('user-agent')?.slice(0, 200),
    ip: req.ip,
  });
  return `${session._id}.${secret}`;
}

export async function issueTokens(req, res, user) {
  const refresh = await createSession(req, user);
  res.cookie(REFRESH_COOKIE, refresh, cookieOptions);
  return signAccessToken(user);
}

// Rotation: every refresh replaces the token. If an already-used token shows up
// again, someone copied it, so the whole family is revoked.
export async function rotateRefreshToken(req, res) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  const [id, secret] = String(raw || '').split('.');
  if (!id || !secret || !/^[a-f\d]{24}$/i.test(id)) throw unauthenticated();

  const session = await Session.findById(id);
  if (!session || !safeEqual(session.tokenHash, sha256(secret)) || session.expiresAt < new Date()) {
    throw unauthenticated();
  }
  if (session.revokedAt) {
    await Session.updateMany({ family: session.family }, { revokedAt: new Date() });
    throw unauthenticated();
  }

  session.revokedAt = new Date();
  await session.save();

  const refresh = await createSession(req, { _id: session.userId }, session.family);
  res.cookie(REFRESH_COOKIE, refresh, cookieOptions);
  return session.userId;
}

export async function revokeCurrent(req, res) {
  const [id] = String(req.cookies?.[REFRESH_COOKIE] || '').split('.');
  if (/^[a-f\d]{24}$/i.test(id)) await Session.updateOne({ _id: id }, { revokedAt: new Date() });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
}

export const revokeAll = (userId) => Session.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
