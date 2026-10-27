import { User, Role } from '../modules/staff/model.js';
import { hasPermission } from '../middleware/auth.js';
import { AppError } from './errors.js';
import { hmac } from './crypto.js';

export const pinHash = (restaurantId, pin) => hmac(`pin:${restaurantId}:${pin}`);

const failures = new Map(); // userId -> { count, until }
const LOCK_MS = 15 * 60 * 1000;

/**
 * For actions a cashier may need a manager for (void, big discount).
 * Returns null if the current user can do it alone, otherwise the approver's id.
 * `allowed(role)` adds a role-level check, e.g. discount within maxDiscountPercent.
 */
export async function requireApproval(req, { permission, allowed = () => true, approval }) {
  if (hasPermission(req, permission) && allowed(req.role)) return null;

  const key = String(req.user._id);
  const f = failures.get(key);
  if (f && f.until > Date.now()) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many wrong PINs. Try again in 15 minutes');
  }
  if (!approval?.pin) throw new AppError(403, 'APPROVAL_REQUIRED', 'Manager approval is needed for this');

  const approver = await User.findOne({
    restaurantId: req.restaurantId,
    pinHash: pinHash(req.restaurantId, approval.pin),
    isActive: true,
  });
  const role = approver && await Role.findOne({ _id: approver.roleId, restaurantId: req.restaurantId }).lean();
  const ok = role && (role.isOwner || role.permissions.includes(permission)) && allowed(role)
    && String(approver._id) !== key;

  if (!ok) {
    const count = (f?.count || 0) + 1;
    failures.set(key, { count, until: count >= 5 ? Date.now() + LOCK_MS : 0 });
    throw new AppError(403, 'APPROVAL_INVALID', 'That PIN cannot approve this');
  }
  failures.delete(key);
  return approver._id;
}
