import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import env from '../../config/env.js';
import { validate, zId } from '../../middleware/validate.js';
import { authenticate, can } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { authLimiter, otpLimiter } from '../../middleware/limits.js';
import { ok, created } from '../../lib/http.js';
import { withTransaction } from '../../lib/db.js';
import { AppError, badRequest, unauthenticated, conflict } from '../../lib/errors.js';
import { zPhone, normalizePhone } from '../../lib/phone.js';
import { hmac, randomDigits, randomToken, sha256, safeEqual } from '../../lib/crypto.js';
import { pinHash } from '../../lib/approval.js';
import { sendMail } from '../../lib/mailer.js';
import { audit } from '../../lib/audit.js';
import { Restaurant, Outlet } from '../outlets/model.js';
import { User, Role, DEFAULT_ROLES } from '../staff/model.js';
import { TaxGroup, DEFAULT_TAX_GROUPS } from '../taxes/model.js';
import { Otp, Device } from './model.js';
import {
  issueTokens, rotateRefreshToken, revokeCurrent, revokeAll, signAccessToken,
  signPurposeToken, verifyPurposeToken,
} from './tokens.js';

const router = Router();

const zPassword = z.string().min(8, 'At least 8 characters').max(100);
const zEmail = z.email().trim().toLowerCase().max(120);

export async function profile(user, role) {
  const outlets = await Outlet.find(
    role.isOwner ? { restaurantId: user.restaurantId } : { restaurantId: user.restaurantId, _id: { $in: user.outletIds } },
  ).select('name slug city').lean();
  return {
    user: { ...user.toJSON(), hasPin: Boolean(user.pinHash) },
    role: { id: String(role._id), name: role.name, isOwner: role.isOwner, maxDiscountPercent: role.maxDiscountPercent },
    permissions: role.permissions,
    outlets: outlets.map((o) => ({ id: String(o._id), name: o.name, slug: o.slug, city: o.city })),
  };
}

// "login" is an email or a phone number.
function loginFilter(login) {
  if (login.includes('@')) return { email: login.trim().toLowerCase() };
  const phone = normalizePhone(login);
  return phone ? { phone } : null;
}

export const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export async function uniqueSlug(base, session) {
  let slug = slugify(base) || 'outlet';
  while (await Outlet.exists({ slug }).setOptions({ crossTenant: true }).session(session)) {
    slug = `${slugify(base)}-${randomDigits(4)}`;
  }
  return slug;
}

// --- signup ---------------------------------------------------------------

router.post('/signup', authLimiter, validate({
  body: z.strictObject({
    restaurantName: z.string().trim().min(2).max(80),
    outletName: z.string().trim().min(2).max(80),
    city: z.string().trim().min(2).max(60),
    ownerName: z.string().trim().min(2).max(80),
    email: zEmail,
    phone: zPhone,
    password: zPassword,
  }),
}), async (req, res) => {
  const b = req.body;
  const passwordHash = await bcrypt.hash(b.password, 12);

  const { user, role } = await withTransaction(async (session) => {
    const [restaurant] = await Restaurant.create([{ name: b.restaurantName }], { session });
    const restaurantId = restaurant._id;
    const [outlet] = await Outlet.create([{
      restaurantId,
      name: b.outletName,
      city: b.city,
      slug: await uniqueSlug(`${b.outletName} ${b.city}`, session),
      phone: b.phone,
      email: b.email,
    }], { session });

    const roles = await Role.insertMany(DEFAULT_ROLES.map((r) => ({ ...r, restaurantId })), { session });
    await TaxGroup.insertMany(DEFAULT_TAX_GROUPS.map((t) => ({ ...t, restaurantId })), { session });

    const ownerRole = roles.find((r) => r.isOwner);
    const [owner] = await User.create([{
      restaurantId,
      name: b.ownerName,
      email: b.email,
      phone: b.phone,
      passwordHash,
      roleId: ownerRole._id,
      outletIds: [outlet._id],
    }], { session });

    restaurant.ownerId = owner._id;
    await restaurant.save({ session });
    return { user: owner, role: ownerRole.toObject() };
  });

  const verifyToken = signPurposeToken('verify_email', user._id, '2d');
  sendMail({
    to: user.email,
    subject: 'Verify your ServeKaro email',
    text: `Welcome to ServeKaro! Verify your email: ${env.frontendUrl}/verify-email?token=${verifyToken}`,
  }).catch(() => {});

  const accessToken = await issueTokens(req, res, user);
  created(res, { accessToken, ...(await profile(user, role)) });
});

router.post('/verify-email', validate({ body: z.strictObject({ token: z.string().max(1000) }) }), async (req, res) => {
  const { sub } = verifyPurposeToken(req.body.token, 'verify_email');
  await User.updateOne({ _id: sub }, { emailVerified: true }).setOptions({ crossTenant: true });
  ok(res);
});

// --- login / tokens ---------------------------------------------------------

// Compared against when the user doesn't exist, so timing doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

router.post('/login', authLimiter, validate({
  body: z.strictObject({ login: z.string().trim().min(3).max(120), password: z.string().min(1).max(100) }),
}), async (req, res) => {
  const filter = loginFilter(req.body.login);
  const user = filter && await User.findOne(filter).setOptions({ crossTenant: true });
  const valid = await bcrypt.compare(req.body.password, user?.passwordHash || DUMMY_HASH);
  if (!user || !valid || !user.isActive) {
    throw new AppError(401, 'INVALID_LOGIN', 'Wrong email/phone or password');
  }
  const role = await Role.findOne({ _id: user.roleId, restaurantId: user.restaurantId }).lean();
  user.lastLoginAt = new Date();
  await user.save();
  const accessToken = await issueTokens(req, res, user);
  ok(res, { accessToken, ...(await profile(user, role)) });
});

router.post('/refresh', authLimiter, async (req, res) => {
  const userId = await rotateRefreshToken(req, res);
  const user = await User.findById(userId).setOptions({ crossTenant: true });
  if (!user || !user.isActive) throw unauthenticated();
  ok(res, { accessToken: signAccessToken(user) });
});

router.post('/logout', async (req, res) => {
  await revokeCurrent(req, res);
  ok(res);
});

// --- PIN login on a registered POS terminal ------------------------------

router.post('/pin-login', authLimiter, validate({
  body: z.strictObject({ pin: z.string().regex(/^\d{4,6}$/) }),
}), async (req, res) => {
  const token = req.get('x-device-token');
  if (!token) throw unauthenticated('This device is not registered');
  const device = await Device.findOne({ tokenHash: sha256(token) }).setOptions({ crossTenant: true });
  if (!device) throw unauthenticated('This device is not registered');
  if (device.lockedUntil > new Date()) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many wrong PINs. Try again in 15 minutes');
  }

  const user = await User.findOne({
    restaurantId: device.restaurantId,
    pinHash: pinHash(device.restaurantId, req.body.pin),
    isActive: true,
  });
  const role = user && await Role.findOne({ _id: user.roleId, restaurantId: user.restaurantId }).lean();
  const canUseOutlet = role && (role.isOwner || user.outletIds.some((o) => String(o) === String(device.outletId)));

  if (!canUseOutlet) {
    device.failedPins += 1;
    if (device.failedPins >= 5) {
      device.failedPins = 0;
      device.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    }
    await device.save();
    throw new AppError(401, 'INVALID_LOGIN', 'Wrong PIN');
  }

  device.failedPins = 0;
  device.lastUsedAt = new Date();
  await device.save();
  // No refresh cookie for PIN sessions: the terminal logs in again per shift/user.
  ok(res, { accessToken: signAccessToken(user), outletId: String(device.outletId), ...(await profile(user, role)) });
});

// --- password reset ----------------------------------------------------------

router.post('/forgot-password', otpLimiter, validate({
  body: z.strictObject({ login: z.string().trim().min(3).max(120) }),
}), async (req, res) => {
  const filter = loginFilter(req.body.login);
  const user = filter && await User.findOne(filter).setOptions({ crossTenant: true });

  if (user?.isActive && user.email) {
    const code = randomDigits(6);
    const login = req.body.login.trim().toLowerCase();
    await Otp.create({
      login,
      purpose: 'reset_password',
      codeHash: hmac(`otp:${login}:${code}`),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    sendMail({
      to: user.email,
      subject: 'Your ServeKaro password reset code',
      text: `Your code is ${code}. It expires in 10 minutes. If you didn't ask for this, ignore this email.`,
    }).catch(() => {});
  }
  // Same answer either way so this can't be used to find accounts.
  ok(res, null);
});

router.post('/reset-password', authLimiter, validate({
  body: z.strictObject({
    login: z.string().trim().min(3).max(120),
    otp: z.string().regex(/^\d{6}$/),
    newPassword: zPassword,
  }),
}), async (req, res) => {
  const login = req.body.login.trim().toLowerCase();
  const otp = await Otp.findOne({ login, purpose: 'reset_password', usedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 });
  const fail = () => new AppError(400, 'INVALID_OTP', 'The code is wrong or has expired');
  if (!otp || otp.attempts >= 5) throw fail();

  if (!safeEqual(otp.codeHash, hmac(`otp:${login}:${req.body.otp}`))) {
    otp.attempts += 1;
    await otp.save();
    throw fail();
  }

  const filter = loginFilter(login);
  const user = filter && await User.findOne(filter).setOptions({ crossTenant: true });
  if (!user) throw fail();

  otp.usedAt = new Date();
  await otp.save();
  user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  user.tokenVersion += 1;
  await user.save();
  await revokeAll(user._id);
  ok(res);
});

// --- invites (staff set their own password) --------------------------------

router.post('/accept-invite', authLimiter, validate({
  body: z.strictObject({ token: z.string().max(1000), password: zPassword }),
}), async (req, res) => {
  const { sub } = verifyPurposeToken(req.body.token, 'invite');
  const user = await User.findById(sub).setOptions({ crossTenant: true });
  if (!user || !user.isActive) throw unauthenticated('This invite is no longer valid');
  if (user.passwordHash) throw conflict('ALREADY_ACCEPTED', 'This invite was already used. Log in instead');
  user.passwordHash = await bcrypt.hash(req.body.password, 12);
  user.emailVerified = true;
  await user.save();
  ok(res);
});

// --- logged-in user -------------------------------------------------------

router.get('/me', authenticate, async (req, res) => {
  ok(res, await profile(req.user, req.role));
});

router.patch('/me', authenticate, validate({
  body: z.strictObject({
    name: z.string().trim().min(2).max(80).optional(),
    email: zEmail.optional(),
    phone: zPhone.optional(),
  }),
}), async (req, res) => {
  if (req.body.email && req.body.email !== req.user.email) req.user.emailVerified = false;
  Object.assign(req.user, req.body);
  await req.user.save();
  ok(res, await profile(req.user, req.role));
});

router.post('/change-password', authenticate, authLimiter, validate({
  body: z.strictObject({ currentPassword: z.string().max(100), newPassword: zPassword }),
}), async (req, res) => {
  const valid = req.user.passwordHash && await bcrypt.compare(req.body.currentPassword, req.user.passwordHash);
  if (!valid) throw badRequest('Current password is wrong', { currentPassword: ['Wrong password'] });
  req.user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  req.user.tokenVersion += 1;
  await req.user.save();
  await revokeAll(req.user._id);
  const accessToken = await issueTokens(req, res, req.user);
  ok(res, { accessToken });
});

// --- devices ---------------------------------------------------------------

router.post('/devices', authenticate, can('settings.edit'), outletScope, validate({
  body: z.strictObject({ name: z.string().trim().min(1).max(60) }),
}), async (req, res) => {
  const deviceToken = randomToken(32);
  const device = await Device.create({
    restaurantId: req.restaurantId,
    outletId: req.outletId,
    name: req.body.name,
    tokenHash: sha256(deviceToken),
    createdBy: req.user._id,
  });
  await audit(req, 'device.register', { entity: 'Device', entityId: device._id, details: { name: device.name } });
  // Shown once. The terminal stores it and sends it as X-Device-Token.
  created(res, { device, deviceToken });
});

router.get('/devices', authenticate, can('settings.edit'), outletScope, async (req, res) => {
  ok(res, await Device.find({ restaurantId: req.restaurantId, outletId: req.outletId }));
});

router.delete('/devices/:id', authenticate, can('settings.edit'), validate({
  params: z.strictObject({ id: zId }),
}), async (req, res) => {
  await Device.deleteOne({ _id: req.params.id, restaurantId: req.restaurantId });
  ok(res);
});

export default router;
