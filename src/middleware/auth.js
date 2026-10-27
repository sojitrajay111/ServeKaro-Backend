import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { User, Role } from '../modules/staff/model.js';
import { unauthenticated, forbidden } from '../lib/errors.js';

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthenticated();
  }
}

// Loads user + role on every request, so disabling a user or changing their
// password (tokenVersion++) takes effect immediately, not after token expiry.
export async function loadPrincipal(payload) {
  const user = await User.findOne({ _id: payload.sub, restaurantId: payload.rid });
  if (!user || !user.isActive || user.tokenVersion !== payload.ver) throw unauthenticated();
  const role = await Role.findOne({ _id: user.roleId, restaurantId: user.restaurantId }).lean();
  if (!role) throw unauthenticated();
  return { user, role };
}

export async function authenticate(req, res, next) {
  if (req.user) return next();
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw unauthenticated();
  const payload = verifyAccessToken(header.slice(7));
  const { user, role } = await loadPrincipal(payload);
  req.user = user;
  req.role = role;
  req.restaurantId = user.restaurantId;
  req.permissions = new Set(role.permissions);
  next();
}

export const hasPermission = (req, permission) => req.role?.isOwner || req.permissions?.has(permission);

export const can = (permission) => (req, res, next) => {
  if (!hasPermission(req, permission)) throw forbidden();
  next();
};

export const ownerOnly = (req, res, next) => {
  if (!req.role?.isOwner) throw forbidden('Only the owner can do this');
  next();
};
