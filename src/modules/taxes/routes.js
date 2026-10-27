import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can } from '../../middleware/auth.js';
import { validate, idParams } from '../../middleware/validate.js';
import { ok, created } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { MenuItem } from '../menu/model.js';
import { TaxGroup } from './model.js';

const router = Router();
router.use('/tax-groups', authenticate);

const body = z.strictObject({
  name: z.string().trim().min(2).max(40),
  components: z.array(z.strictObject({
    name: z.string().trim().min(2).max(20),
    rate: z.number().min(0).max(50),
  })).max(4),
});

router.get('/tax-groups', async (req, res) => {
  ok(res, await TaxGroup.find({ restaurantId: req.restaurantId }).sort({ name: 1 }));
});

router.post('/tax-groups', can('settings.edit'), validate({ body }), async (req, res) => {
  const group = await TaxGroup.create({ ...req.body, restaurantId: req.restaurantId });
  await audit(req, 'tax_group.create', { entity: 'TaxGroup', entityId: group._id, details: req.body });
  created(res, group);
});

// Changing a rate only affects new orders: orders copy tax components when items are added.
router.patch('/tax-groups/:id', idParams, can('settings.edit'), validate({ body: body.partial() }), async (req, res) => {
  const group = await TaxGroup.findOneAndUpdate({ _id: req.params.id, restaurantId: req.restaurantId }, req.body, { new: true });
  if (!group) throw notFound('Tax group');
  await audit(req, 'tax_group.update', { entity: 'TaxGroup', entityId: group._id, details: req.body });
  ok(res, group);
});

router.delete('/tax-groups/:id', idParams, can('settings.edit'), async (req, res) => {
  if (await MenuItem.exists({ restaurantId: req.restaurantId, taxGroupId: req.params.id, deletedAt: null })) {
    throw conflict('TAX_GROUP_IN_USE', 'Some menu items still use this tax group');
  }
  const { deletedCount } = await TaxGroup.deleteOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!deletedCount) throw notFound('Tax group');
  ok(res);
});

export default router;
