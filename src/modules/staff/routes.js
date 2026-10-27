import { Router } from 'express';
import { z } from 'zod';
import env from '../../config/env.js';
import { authenticate, can } from '../../middleware/auth.js';
import { validate, zId, idParams } from '../../middleware/validate.js';
import { ok, created } from '../../lib/http.js';
import { zPhone } from '../../lib/phone.js';
import { pinHash } from '../../lib/approval.js';
import { sendMail } from '../../lib/mailer.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { Outlet } from '../outlets/model.js';
import { User, Role, PERMISSIONS } from './model.js';
import { signPurposeToken, revokeAll } from '../auth/tokens.js';

const router = Router();
// Routers share the /api/v1 mount, so scope middleware to this router's paths.
router.use(['/staff', '/roles'], authenticate, can('staff.manage'));

const zPin = z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits');

const staffJson = (u) => ({ ...u.toJSON(), hasPin: Boolean(u.pinHash) });

async function checkRoleAndOutlets(req, roleId, outletIds) {
  if (roleId) {
    const role = await Role.findOne({ _id: roleId, restaurantId: req.restaurantId });
    if (!role) throw badRequest('Unknown role', { roleId: ['Unknown role'] });
    if (role.isOwner && !req.role.isOwner) throw forbidden('Only the owner can assign the Owner role');
  }
  if (outletIds) {
    const count = await Outlet.countDocuments({ restaurantId: req.restaurantId, _id: { $in: outletIds } });
    if (count !== outletIds.length) throw badRequest('Unknown outlet', { outletIds: ['Unknown outlet'] });
  }
}

function sendInvite(user) {
  if (!user.email) return;
  const token = signPurposeToken('invite', user._id, '7d');
  sendMail({
    to: user.email,
    subject: 'You have been added to ServeKaro',
    text: `Hi ${user.name}, set your password to start: ${env.frontendUrl}/admin/accept-invite?token=${token}\nThis link expires in 7 days.`,
  }).catch(() => {});
}

// --- staff ----------------------------------------------------------------

router.get('/staff', async (req, res) => {
  const users = await User.find({ restaurantId: req.restaurantId }).sort({ name: 1 });
  ok(res, users.map(staffJson));
});

router.post('/staff', validate({
  body: z.strictObject({
    name: z.string().trim().min(2).max(80),
    phone: zPhone,
    email: z.email().trim().toLowerCase().optional(),
    roleId: zId,
    outletIds: z.array(zId).min(1),
    pin: zPin.optional(),
  }),
}), async (req, res) => {
  const { pin, ...data } = req.body;
  await checkRoleAndOutlets(req, data.roleId, data.outletIds);
  const user = await User.create({
    ...data,
    restaurantId: req.restaurantId,
    pinHash: pin ? pinHash(req.restaurantId, pin) : undefined,
  });
  sendInvite(user);
  await audit(req, 'staff.create', { entity: 'User', entityId: user._id, details: { name: user.name, roleId: data.roleId } });
  created(res, staffJson(user));
});

router.patch('/staff/:id', idParams, validate({
  body: z.strictObject({
    name: z.string().trim().min(2).max(80).optional(),
    phone: zPhone.optional(),
    email: z.email().trim().toLowerCase().optional(),
    roleId: zId.optional(),
    outletIds: z.array(zId).min(1).optional(),
    isActive: z.boolean().optional(),
  }),
}), async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!user) throw notFound('Staff member');
  const owner = await Role.findOne({ _id: user.roleId, restaurantId: req.restaurantId });
  if (owner?.isOwner && !req.role.isOwner) throw forbidden('Only the owner can edit the owner');
  if (String(user._id) === String(req.user._id) && req.body.isActive === false) {
    throw conflict('CANNOT_DISABLE_SELF', 'You cannot disable your own account');
  }
  await checkRoleAndOutlets(req, req.body.roleId, req.body.outletIds);

  const roleChanged = req.body.roleId && req.body.roleId !== String(user.roleId);
  Object.assign(user, req.body);
  if (req.body.isActive === false || roleChanged) user.tokenVersion += 1;
  await user.save();
  if (req.body.isActive === false) await revokeAll(user._id);

  await audit(req, 'staff.update', { entity: 'User', entityId: user._id, details: req.body });
  ok(res, staffJson(user));
});

router.post('/staff/:id/reset-pin', idParams, validate({ body: z.strictObject({ pin: zPin }) }), async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!user) throw notFound('Staff member');
  user.pinHash = pinHash(req.restaurantId, req.body.pin);
  try {
    await user.save();
  } catch (err) {
    if (err.code === 11000) throw conflict('PIN_TAKEN', 'Someone else already uses this PIN');
    throw err;
  }
  await audit(req, 'staff.reset_pin', { entity: 'User', entityId: user._id });
  ok(res);
});

router.post('/staff/:id/resend-invite', idParams, async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!user) throw notFound('Staff member');
  if (user.passwordHash) throw conflict('ALREADY_ACCEPTED', 'This person already has a password');
  sendInvite(user);
  ok(res);
});

// --- roles ----------------------------------------------------------------

const roleBody = z.strictObject({
  name: z.string().trim().min(2).max(40),
  permissions: z.array(z.enum(PERMISSIONS)),
  maxDiscountPercent: z.number().min(0).max(100),
});

router.get('/roles', async (req, res) => {
  ok(res, { roles: await Role.find({ restaurantId: req.restaurantId }).sort({ isOwner: -1, name: 1 }), permissions: PERMISSIONS });
});

router.post('/roles', validate({ body: roleBody }), async (req, res) => {
  const role = await Role.create({ ...req.body, restaurantId: req.restaurantId });
  await audit(req, 'role.create', { entity: 'Role', entityId: role._id, details: req.body });
  created(res, role);
});

router.patch('/roles/:id', idParams, validate({ body: roleBody.partial() }), async (req, res) => {
  const role = await Role.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!role) throw notFound('Role');
  if (role.isOwner) throw forbidden('The Owner role cannot be changed');
  Object.assign(role, req.body);
  await role.save();
  await audit(req, 'role.update', { entity: 'Role', entityId: role._id, details: req.body });
  ok(res, role);
});

router.delete('/roles/:id', idParams, async (req, res) => {
  const role = await Role.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!role) throw notFound('Role');
  if (role.isOwner) throw forbidden('The Owner role cannot be deleted');
  if (await User.exists({ restaurantId: req.restaurantId, roleId: role._id })) {
    throw conflict('ROLE_IN_USE', 'Move staff to another role first');
  }
  await role.deleteOne();
  await audit(req, 'role.delete', { entity: 'Role', entityId: role._id, details: { name: role.name } });
  ok(res);
});

export default router;
