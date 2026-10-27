import { Order, Kot } from './model.js';
import { MenuItem, AddonGroup, Category } from '../menu/model.js';
import { TaxGroup } from '../taxes/model.js';
import { computeBill, lineAmount } from '../../lib/money.js';
import { nextSeq } from '../../lib/counters.js';
import { businessDate } from '../../lib/dates.js';
import { emit, rooms } from '../../lib/events.js';
import { AppError, badRequest } from '../../lib/errors.js';

export const activeItems = (order) => order.items.filter((i) => i.status === 'active' && i.qty > 0);

export function serviceChargePercent(outlet, orderType) {
  const sc = outlet.serviceCharge;
  return sc?.enabled && sc.orderTypes.includes(orderType) ? sc.percent : 0;
}

export const billLines = (items) => items.map((i) => ({
  amount: lineAmount(i),
  taxComponents: i.taxComponents || [],
}));

// Running total shown on the POS and table map before the bill is made.
export function recalcOrder(order, outlet) {
  order.amounts = computeBill(billLines(activeItems(order)), {
    pricesIncludeTax: outlet.pricesIncludeTax,
    serviceChargePercent: serviceChargePercent(outlet, order.type),
    roundOff: outlet.roundOff,
  });
  return order;
}

/**
 * Turns [{ itemId, variantId, addonIds, qty, note }] into order item snapshots,
 * with prices and taxes taken from the menu. The client never sends prices.
 */
export async function buildItems({ restaurantId, outlet, orderType, status = 'active', userId }, inputs) {
  const itemIds = [...new Set(inputs.map((i) => i.itemId))];
  const menuItems = await MenuItem.find({ _id: { $in: itemIds }, restaurantId, outletId: outlet._id, deletedAt: null });
  const byId = new Map(menuItems.map((m) => [String(m._id), m]));

  const groupIds = [...new Set(menuItems.flatMap((m) => m.addonGroupIds.map(String)))];
  const taxIds = [...new Set(menuItems.map((m) => m.taxGroupId && String(m.taxGroupId)).filter(Boolean))];
  const catIds = [...new Set(menuItems.map((m) => String(m.categoryId)))];
  const [groups, taxGroups, categories] = await Promise.all([
    AddonGroup.find({ _id: { $in: groupIds }, restaurantId }),
    TaxGroup.find({ _id: { $in: taxIds }, restaurantId }),
    Category.find({ _id: { $in: catIds }, restaurantId }),
  ]);
  const taxById = new Map(taxGroups.map((t) => [String(t._id), t]));
  const catById = new Map(categories.map((c) => [String(c._id), c]));

  return inputs.map((input, idx) => {
    const m = byId.get(input.itemId);
    const field = (msg) => badRequest(msg, { [`items.${idx}.itemId`]: [msg] });
    if (!m || !m.isActive) throw field('This item is not available');
    if (!m.inStock) throw new AppError(409, 'ITEM_SOLD_OUT', `${m.name} is sold out`);

    let unitPrice = m.orderTypePrices?.[orderType] ?? m.price;
    let variant = null;
    if (m.variants.length) {
      variant = input.variantId && m.variants.id(input.variantId);
      if (!variant) throw field(`Choose a size/variant for ${m.name}`);
      unitPrice = variant.price;
    }

    // Add-ons: must belong to the item's groups, and respect each group's min/max.
    const myGroups = groups.filter((g) => m.addonGroupIds.some((id) => String(id) === String(g._id)));
    const chosen = input.addonIds || [];
    const addons = [];
    for (const g of myGroups) {
      const picked = g.addons.filter((a) => a.isActive && chosen.includes(String(a._id)));
      if (picked.length < g.min || picked.length > g.max) {
        throw field(`${g.name}: choose ${g.min === g.max ? g.min : `${g.min}–${g.max}`}`);
      }
      addons.push(...picked.map((a) => ({ addonId: a._id, name: a.name, price: a.price })));
    }
    if (addons.length !== chosen.length) throw field(`Some add-ons are not available for ${m.name}`);

    const tax = m.taxGroupId && taxById.get(String(m.taxGroupId));
    return {
      itemId: m._id,
      name: m.name,
      variantId: variant?._id,
      variantName: variant?.name,
      addons,
      qty: input.qty,
      unitPrice,
      taxComponents: tax ? tax.components.map((c) => ({ name: c.name, rate: c.rate })) : [],
      hsn: m.hsn,
      categoryId: m.categoryId,
      categoryName: catById.get(String(m.categoryId))?.name,
      stationId: m.stationId,
      foodType: m.foodType,
      note: input.note || '',
      status,
      addedBy: userId,
    };
  });
}

/**
 * One KOT per kitchen station for the given order items (subdocs already on
 * the order). Sets kotId on each item. Returns the created KOTs.
 */
export async function createKots(order, items, { outlet, userId, type = 'new', qtyOf = (i) => i.qty }, session) {
  if (!items.length) return [];
  const date = businessDate(outlet.timezone);
  const byStation = new Map();
  for (const i of items) {
    const key = i.stationId ? String(i.stationId) : '';
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key).push(i);
  }

  const kots = [];
  for (const [stationId, group] of byStation) {
    const kotNo = await nextSeq(`kot:${outlet._id}:${date}`, session);
    const [kot] = await Kot.create([{
      restaurantId: order.restaurantId,
      outletId: outlet._id,
      kotNo,
      businessDate: date,
      orderId: order._id,
      orderNo: order.orderNo,
      orderType: order.type,
      tableName: order.tableName,
      stationId: stationId || null,
      type,
      items: group.map((i) => ({
        orderItemId: i._id,
        name: i.name,
        variantName: i.variantName,
        addons: i.addons.map((a) => a.name),
        qty: qtyOf(i),
        note: i.note,
      })),
      createdBy: userId,
    }], { session });
    if (type === 'new') group.forEach((i) => { i.kotId = kot._id; });
    kots.push(kot);
  }
  return kots;
}

export async function nextOrderNo(outlet, session) {
  const date = businessDate(outlet.timezone);
  return { orderNo: await nextSeq(`order:${outlet._id}:${date}`, session), businessDate: date };
}

// --- realtime ---------------------------------------------------------------

export function emitOrder(order, event = 'order.updated') {
  emit([rooms.outlet(order.outletId), rooms.order(order._id)], event, order.toJSON());
}

export function emitKots(kots) {
  for (const k of kots) {
    const json = k.toJSON();
    emit([rooms.outlet(k.outletId), k.stationId && rooms.station(k.stationId)], 'kot.created', json);
    emit(rooms.outlet(k.outletId), 'print', { kind: 'kot', id: json.id, stationId: json.stationId ?? null });
  }
}

export const findOrder = (req, id, session) =>
  Order.findOne({ _id: id, restaurantId: req.restaurantId, outletId: req.outletId }).session(session || null);
