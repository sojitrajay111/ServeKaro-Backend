import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { validate, zId, zMoney, idParams, zPaging } from '../../middleware/validate.js';
import { imageUpload, assertImage } from '../../middleware/upload.js';
import { ok, created, list, escapeRegex } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { emit, rooms } from '../../lib/events.js';
import { uploadImage, deleteImage } from '../../lib/storage.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { TaxGroup } from '../taxes/model.js';
import { Category, MenuItem, AddonGroup, Station } from './model.js';
import { loadMenu } from './service.js';

const router = Router();
router.use(['/menu', '/stations', '/categories', '/addon-groups', '/items'], authenticate, outletScope);

const scope = (req) => ({ restaurantId: req.restaurantId, outletId: req.outletId });
const zName = z.string().trim().min(1).max(80);
const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

router.get('/menu', can('menu.view'), async (req, res) => {
  ok(res, await loadMenu(req.restaurantId, req.outletId));
});

// --- stations ---------------------------------------------------------------

router.get('/stations', can('menu.view'), async (req, res) => {
  ok(res, await Station.find(scope(req)).sort({ name: 1 }));
});

router.post('/stations', can('settings.edit'), validate({ body: z.strictObject({ name: zName }) }), async (req, res) => {
  created(res, await Station.create({ ...scope(req), ...req.body }));
});

router.patch('/stations/:id', idParams, can('settings.edit'), validate({ body: z.strictObject({ name: zName }) }), async (req, res) => {
  const s = await Station.findOneAndUpdate({ _id: req.params.id, ...scope(req) }, req.body, { new: true });
  if (!s) throw notFound('Station');
  ok(res, s);
});

router.delete('/stations/:id', idParams, can('settings.edit'), async (req, res) => {
  if (await MenuItem.exists({ ...scope(req), stationId: req.params.id, deletedAt: null })) {
    throw conflict('STATION_IN_USE', 'Move items to another station first');
  }
  await Station.deleteOne({ _id: req.params.id, ...scope(req) });
  ok(res);
});

// --- categories -------------------------------------------------------------

const categoryBody = z.strictObject({
  name: zName,
  sortOrder: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
  availability: z.strictObject({ days: z.array(z.number().int().min(1).max(7)), from: zTime, to: zTime }).nullable().optional(),
});

router.get('/categories', can('menu.view'), async (req, res) => {
  ok(res, await Category.find(scope(req)).sort({ sortOrder: 1, name: 1 }));
});

router.post('/categories', can('menu.edit'), validate({ body: categoryBody }), async (req, res) => {
  created(res, await Category.create({ ...scope(req), ...req.body }));
});

router.put('/categories/order', can('menu.edit'), validate({ body: z.strictObject({ ids: z.array(zId).max(500) }) }), async (req, res) => {
  await Category.bulkWrite(req.body.ids.map((id, i) => ({
    updateOne: { filter: { _id: id, ...scope(req) }, update: { sortOrder: i } },
  })));
  ok(res);
});

router.patch('/categories/:id', idParams, can('menu.edit'), validate({ body: categoryBody.partial() }), async (req, res) => {
  const c = await Category.findOneAndUpdate({ _id: req.params.id, ...scope(req) }, req.body, { new: true });
  if (!c) throw notFound('Category');
  ok(res, c);
});

router.delete('/categories/:id', idParams, can('menu.edit'), async (req, res) => {
  if (await MenuItem.exists({ ...scope(req), categoryId: req.params.id, deletedAt: null })) {
    throw conflict('CATEGORY_NOT_EMPTY', 'Move or delete the items in this category first');
  }
  const { deletedCount } = await Category.deleteOne({ _id: req.params.id, ...scope(req) });
  if (!deletedCount) throw notFound('Category');
  ok(res);
});

// --- add-on groups ------------------------------------------------------------

const addonGroupBody = z.strictObject({
  name: zName,
  min: z.number().int().min(0).max(20),
  max: z.number().int().min(1).max(20),
  addons: z.array(z.strictObject({
    id: zId.optional(),
    name: zName,
    price: zMoney,
    foodType: z.enum(['veg', 'nonveg', 'egg']).optional(),
    isActive: z.boolean().optional(),
  })).min(1).max(50),
}).refine((g) => g.min <= g.max, { message: 'min cannot be more than max', path: ['min'] });

// Keep existing add-on ids so they stay stable for open orders.
const toAddonDocs = (addons) => addons.map(({ id, ...a }) => (id ? { _id: id, ...a } : a));

router.get('/addon-groups', can('menu.view'), async (req, res) => {
  ok(res, await AddonGroup.find(scope(req)).sort({ name: 1 }));
});

router.post('/addon-groups', can('menu.edit'), validate({ body: addonGroupBody }), async (req, res) => {
  created(res, await AddonGroup.create({ ...scope(req), ...req.body, addons: toAddonDocs(req.body.addons) }));
});

router.patch('/addon-groups/:id', idParams, can('menu.edit'), validate({ body: addonGroupBody }), async (req, res) => {
  const g = await AddonGroup.findOneAndUpdate(
    { _id: req.params.id, ...scope(req) },
    { ...req.body, addons: toAddonDocs(req.body.addons) },
    { new: true },
  );
  if (!g) throw notFound('Add-on group');
  ok(res, g);
});

router.delete('/addon-groups/:id', idParams, can('menu.edit'), async (req, res) => {
  await MenuItem.updateMany({ ...scope(req) }, { $pull: { addonGroupIds: req.params.id } });
  await AddonGroup.deleteOne({ _id: req.params.id, ...scope(req) });
  ok(res);
});

// --- items --------------------------------------------------------------------

const itemBody = z.strictObject({
  categoryId: zId,
  name: zName,
  shortCode: z.string().trim().max(10).optional(),
  description: z.string().trim().max(500).optional(),
  foodType: z.enum(['veg', 'nonveg', 'egg']),
  price: zMoney,
  variants: z.array(z.strictObject({ id: zId.optional(), name: zName, price: zMoney })).max(10).optional(),
  addonGroupIds: z.array(zId).max(10).optional(),
  taxGroupId: zId.nullable().optional(),
  hsn: z.string().regex(/^\d{4,8}$/).optional(),
  stationId: zId.nullable().optional(),
  prepTimeMin: z.number().int().min(0).max(240).optional(),
  tags: z.array(z.enum(['popular', 'chefSpecial', 'new', 'spicy'])).optional(),
  inStock: z.boolean().optional(),
  isActive: z.boolean().optional(),
  orderTypePrices: z.strictObject({ dine_in: zMoney, takeaway: zMoney, delivery: zMoney }).partial().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

async function checkItemRefs(req, b) {
  const s = scope(req);
  const checks = [];
  if (b.categoryId) checks.push(Category.exists({ _id: b.categoryId, ...s }).then((x) => x || ['categoryId', 'Unknown category']));
  if (b.taxGroupId) checks.push(TaxGroup.exists({ _id: b.taxGroupId, restaurantId: req.restaurantId }).then((x) => x || ['taxGroupId', 'Unknown tax group']));
  if (b.stationId) checks.push(Station.exists({ _id: b.stationId, ...s }).then((x) => x || ['stationId', 'Unknown station']));
  if (b.addonGroupIds?.length) {
    checks.push(AddonGroup.countDocuments({ _id: { $in: b.addonGroupIds }, ...s })
      .then((n) => n === b.addonGroupIds.length || ['addonGroupIds', 'Unknown add-on group']));
  }
  const errors = (await Promise.all(checks)).filter(Array.isArray);
  if (errors.length) throw badRequest('Please check the highlighted fields', Object.fromEntries(errors.map(([k, m]) => [k, [m]])));
}

const toVariantDocs = (variants) => variants?.map(({ id, ...v }) => (id ? { _id: id, ...v } : v));

router.get('/items', can('menu.view'), validate({
  query: z.strictObject({
    categoryId: zId.optional(),
    q: z.string().trim().max(50).optional(),
    inStock: z.enum(['true', 'false']).optional(),
    ...zPaging,
  }),
}), async (req, res) => {
  const { categoryId, q, inStock, page, limit } = req.query;
  const filter = { ...scope(req), deletedAt: null };
  if (categoryId) filter.categoryId = categoryId;
  if (inStock) filter.inStock = inStock === 'true';
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { shortCode: rx }];
  }
  const [items, total] = await Promise.all([
    MenuItem.find(filter).sort({ sortOrder: 1, name: 1 }).skip((page - 1) * limit).limit(limit),
    MenuItem.countDocuments(filter),
  ]);
  list(res, items, { page, limit, total });
});

router.post('/items', can('menu.edit'), validate({ body: itemBody }), async (req, res) => {
  await checkItemRefs(req, req.body);
  const item = await MenuItem.create({ ...scope(req), ...req.body, variants: toVariantDocs(req.body.variants) });
  created(res, item);
});

router.get('/items/:id', idParams, can('menu.view'), async (req, res) => {
  const item = await MenuItem.findOne({ _id: req.params.id, ...scope(req), deletedAt: null });
  if (!item) throw notFound('Item');
  ok(res, item);
});

router.patch('/items/:id', idParams, can('menu.edit'), validate({ body: itemBody.partial() }), async (req, res) => {
  await checkItemRefs(req, req.body);
  const item = await MenuItem.findOne({ _id: req.params.id, ...scope(req), deletedAt: null });
  if (!item) throw notFound('Item');

  const priceChange = req.body.price !== undefined && req.body.price !== item.price;
  const before = item.price;
  item.set({ ...req.body, ...(req.body.variants && { variants: toVariantDocs(req.body.variants) }) });
  await item.save();

  if (priceChange) {
    await audit(req, 'item.price_change', { entity: 'MenuItem', entityId: item._id, details: { name: item.name, from: before, to: item.price } });
  }
  ok(res, item);
});

// Soft delete: past orders and bills still point at it.
router.delete('/items/:id', idParams, can('menu.edit'), async (req, res) => {
  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.id, ...scope(req), deletedAt: null },
    { deletedAt: new Date(), isActive: false },
    { new: true },
  );
  if (!item) throw notFound('Item');
  await audit(req, 'item.delete', { entity: 'MenuItem', entityId: item._id, details: { name: item.name } });
  ok(res);
});

// Captains and cashiers can mark sold out, so this only needs menu.view.
router.patch('/items/:id/stock', idParams, can('menu.view'), validate({ body: z.strictObject({ inStock: z.boolean() }) }), async (req, res) => {
  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.id, ...scope(req), deletedAt: null },
    { inStock: req.body.inStock },
    { new: true },
  );
  if (!item) throw notFound('Item');
  const payload = { itemId: String(item._id), inStock: item.inStock };
  emit([rooms.outlet(req.outletId), rooms.menu(req.outletId)], 'menu.stock', payload);
  ok(res, payload);
});

// --- images ---------------------------------------------------------------------

router.post('/items/:id/images', idParams, can('menu.edit'), imageUpload.array('images', 5), async (req, res) => {
  const item = await MenuItem.findOne({ _id: req.params.id, ...scope(req), deletedAt: null });
  if (!item) throw notFound('Item');
  const files = req.files || [];
  if (!files.length) throw badRequest('Add at least one JPEG, PNG or WebP image');
  if (item.images.length + files.length > 5) throw badRequest('An item can have at most 5 images');
  files.forEach((f) => assertImage(f.buffer));

  const uploaded = await Promise.all(files.map((f) => uploadImage(f.buffer, `servekaro/${req.restaurantId}/items`)));
  uploaded.forEach((u, i) => item.images.push({ ...u, isPrimary: item.images.length === 0 && i === 0 }));
  await item.save();
  created(res, item.images);
});

router.patch('/items/:id/images/:imageId', can('menu.edit'), validate({
  params: z.strictObject({ id: zId, imageId: zId }),
  body: z.strictObject({ isPrimary: z.literal(true) }),
}), async (req, res) => {
  const item = await MenuItem.findOne({ _id: req.params.id, ...scope(req), deletedAt: null });
  const image = item?.images.id(req.params.imageId);
  if (!image) throw notFound('Image');
  item.images.forEach((img) => { img.isPrimary = String(img._id) === req.params.imageId; });
  await item.save();
  ok(res, item.images);
});

router.delete('/items/:id/images/:imageId', can('menu.edit'), validate({
  params: z.strictObject({ id: zId, imageId: zId }),
}), async (req, res) => {
  const item = await MenuItem.findOne({ _id: req.params.id, ...scope(req), deletedAt: null });
  const image = item?.images.id(req.params.imageId);
  if (!image) throw notFound('Image');
  const wasPrimary = image.isPrimary;
  image.deleteOne();
  if (wasPrimary && item.images[0]) item.images[0].isPrimary = true;
  await item.save();
  await deleteImage(image.publicId);
  ok(res, item.images);
});

export default router;
