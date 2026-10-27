import { Category, MenuItem, AddonGroup, Station } from './model.js';
import { TaxGroup } from '../taxes/model.js';

const byOrder = { sortOrder: 1, name: 1 };

/**
 * The whole menu for an outlet in one payload. POS terminals and the QR page
 * load this once and cache it (Express adds an ETag, so reloads are 304s).
 * forCustomers hides inactive categories/items and internal fields.
 */
export async function loadMenu(restaurantId, outletId, { forCustomers = false } = {}) {
  const base = { restaurantId, outletId };
  const active = forCustomers ? { isActive: true } : {};

  const [categories, items, addonGroups, taxGroups, stations] = await Promise.all([
    Category.find({ ...base, ...active }).sort(byOrder),
    MenuItem.find({ ...base, deletedAt: null, ...active }).sort(byOrder),
    AddonGroup.find(base).sort({ name: 1 }),
    forCustomers ? [] : TaxGroup.find({ restaurantId }).sort({ name: 1 }),
    forCustomers ? [] : Station.find(base).sort({ name: 1 }),
  ]);

  if (!forCustomers) {
    return { categories, items, addonGroups, taxGroups, stations };
  }

  const categoryIds = new Set(categories.map((c) => String(c._id)));
  const strip = ({ hsn, stationId, taxGroupId, shortCode, deletedAt, ...rest }) => rest;
  return {
    categories,
    items: items.filter((i) => categoryIds.has(String(i.categoryId))).map((i) => strip(i.toJSON())),
    addonGroups: addonGroups.map((g) => ({ ...g.toJSON(), addons: g.addons.filter((a) => a.isActive) })),
  };
}
