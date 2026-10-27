import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, ownerOnly } from '../../middleware/auth.js';
import { validate, idParams } from '../../middleware/validate.js';
import { ok, created } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { zPhone } from '../../lib/phone.js';
import { User } from '../staff/model.js';
import { Restaurant, Outlet } from './model.js';
import { uniqueSlug } from '../auth/routes.js';

const router = Router();
router.use(['/restaurant', '/outlets'], authenticate);

const zHex = z.string().regex(/^#[0-9a-f]{6}$/i);
const zGstin = z.string().trim().toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN').or(z.literal(''));

const outletBody = z.strictObject({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,50}$/, 'Use a-z, 0-9 and -'),
  city: z.string().trim().max(60),
  address: z.string().trim().max(300),
  phone: zPhone.or(z.literal('')),
  email: z.email().or(z.literal('')),
  gstin: zGstin,
  fssai: z.string().trim().regex(/^\d{14}$/, 'FSSAI is 14 digits').or(z.literal('')),
  timezone: z.string().refine((tz) => {
    try { Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
  }, 'Unknown timezone'),
  billPrefix: z.string().trim().regex(/^[A-Z0-9]{1,6}$/i, 'Up to 6 letters/digits').toUpperCase(),
  financialYearStart: z.string().regex(/^\d{2}-\d{2}$/),
  pricesIncludeTax: z.boolean(),
  roundOff: z.enum(['nearest_rupee', 'none']),
  serviceCharge: z.strictObject({
    enabled: z.boolean(),
    percent: z.number().min(0).max(20),
    orderTypes: z.array(z.enum(['dine_in', 'takeaway', 'delivery'])),
  }),
  orderTypes: z.array(z.enum(['dine_in', 'takeaway', 'delivery'])).min(1),
  qrOrdering: z.strictObject({ enabled: z.boolean(), requireAcceptance: z.boolean(), allowPayLater: z.boolean() }),
  bill: z.strictObject({ header: z.string().max(300), footer: z.string().max(300), showItemTax: z.boolean() }),
  theme: z.strictObject({ primaryColor: zHex, accentColor: zHex, logoUrl: z.url().or(z.literal('')) }),
  isOpen: z.boolean(),
}).partial();

async function findAllowedOutlet(req) {
  const outlet = await Outlet.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!outlet) throw notFound('Outlet');
  if (!req.role.isOwner && !req.user.outletIds.some((o) => String(o) === req.params.id)) throw forbidden();
  return outlet;
}

// --- restaurant -------------------------------------------------------------

router.get('/restaurant', async (req, res) => {
  ok(res, await Restaurant.findById(req.restaurantId));
});

router.patch('/restaurant', can('settings.edit'), validate({
  body: z.strictObject({
    name: z.string().trim().min(2).max(80),
    legalName: z.string().trim().max(120),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').or(z.literal('')),
    logoUrl: z.url().or(z.literal('')),
  }).partial(),
}), async (req, res) => {
  const restaurant = await Restaurant.findByIdAndUpdate(req.restaurantId, req.body, { new: true });
  await audit(req, 'restaurant.update', { entity: 'Restaurant', entityId: restaurant._id, details: req.body });
  ok(res, restaurant);
});

// --- outlets ---------------------------------------------------------------

router.get('/outlets', async (req, res) => {
  const filter = { restaurantId: req.restaurantId };
  if (!req.role.isOwner) filter._id = { $in: req.user.outletIds };
  ok(res, await Outlet.find(filter).sort({ name: 1 }));
});

router.post('/outlets', ownerOnly, validate({
  body: z.strictObject({ name: z.string().trim().min(2).max(80), city: z.string().trim().min(2).max(60) }),
}), async (req, res) => {
  const outlet = await Outlet.create({
    restaurantId: req.restaurantId,
    ...req.body,
    slug: await uniqueSlug(`${req.body.name} ${req.body.city}`),
  });
  await User.updateOne({ _id: req.user._id, restaurantId: req.restaurantId }, { $addToSet: { outletIds: outlet._id } });
  await audit(req, 'outlet.create', { entity: 'Outlet', entityId: outlet._id, details: req.body });
  created(res, outlet);
});

router.get('/outlets/:id', idParams, async (req, res) => {
  ok(res, await findAllowedOutlet(req));
});

router.patch('/outlets/:id', idParams, can('settings.edit'), validate({ body: outletBody }), async (req, res) => {
  const outlet = await findAllowedOutlet(req);
  outlet.set(req.body);
  await outlet.save();
  await audit(req, 'outlet.update', { entity: 'Outlet', entityId: outlet._id, details: req.body });
  ok(res, outlet);
});

export default router;
