import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { validate, zId, zQty, zPaging, idParams } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { ok, created, list } from '../../lib/http.js';
import { withTransaction } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { requireApproval } from '../../lib/approval.js';
import { randomToken } from '../../lib/crypto.js';
import { businessDate } from '../../lib/dates.js';
import { emit, rooms } from '../../lib/events.js';
import { zPhone } from '../../lib/phone.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { Table } from '../tables/model.js';
import { User } from '../staff/model.js';
import { occupyTable, updateTable, freeTable, emitTable } from '../tables/service.js';
import { Order, Kot, ORDER_TYPES } from './model.js';
import {
  buildItems, createKots, recalcOrder, nextOrderNo, emitOrder, emitKots, findOrder, activeItems,
} from './service.js';

const router = Router();
router.use(['/orders', '/kots'], authenticate, outletScope);

export const zItemInput = z.strictObject({
  itemId: zId,
  variantId: zId.optional(),
  addonIds: z.array(zId).max(20).optional(),
  qty: zQty,
  note: z.string().trim().max(140).optional(),
});
const zItems = z.array(zItemInput).min(1).max(100);
const zCustomer = z.strictObject({ name: z.string().trim().max(80).optional(), phone: zPhone.optional() });
const zApproval = z.strictObject({ pin: z.string().regex(/^\d{4,6}$/) }).optional();

const OPEN = ['awaiting_acceptance', 'open'];
const ensureOpen = (order) => {
  if (!order) throw notFound('Order');
  if (!OPEN.includes(order.status)) throw conflict('ORDER_NOT_OPEN', `Order is already ${order.status}`);
};

// Keeps the table map's running amount in sync with the order.
async function syncTableAmount(req, order, session) {
  if (!order.tableId) return null;
  return updateTable(req.restaurantId, order.tableId, { amount: order.amounts.total }, session);
}

// --- list / read ------------------------------------------------------------

router.get('/orders', validate({
  query: z.strictObject({
    status: z.string().regex(/^[a-z_,]+$/).optional(),
    type: z.enum(ORDER_TYPES).optional(),
    tableId: zId.optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    ...zPaging,
  }),
}), async (req, res) => {
  const { status, type, tableId, from, to, page, limit } = req.query;
  const filter = { restaurantId: req.restaurantId, outletId: req.outletId };
  if (status) filter.status = { $in: status.split(',') };
  if (type) filter.type = type;
  if (tableId) filter.tableId = tableId;
  if (from || to) filter.businessDate = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Order.countDocuments(filter),
  ]);
  list(res, orders, { page, limit, total });
});

router.get('/orders/:id', idParams, async (req, res) => {
  const order = await findOrder(req, req.params.id);
  if (!order) throw notFound('Order');
  ok(res, order);
});

// --- create / add items ---------------------------------------------------

router.post('/orders', can('orders.create'), idempotent, validate({
  body: z.strictObject({
    type: z.enum(ORDER_TYPES),
    tableId: zId.optional(),
    covers: z.number().int().min(0).max(100).optional(),
    customer: zCustomer.optional(),
    note: z.string().trim().max(200).optional(),
    items: zItems,
    sendKot: z.boolean().default(true),
  }),
}), async (req, res) => {
  const b = req.body;
  const { outlet } = req;
  if (!outlet.orderTypes.includes(b.type)) throw badRequest(`${b.type.replace('_', ' ')} is turned off for this outlet`);
  if (b.type === 'dine_in' && !b.tableId) throw badRequest('Pick a table', { tableId: ['Required for dine-in'] });
  if (b.type !== 'dine_in' && b.tableId) throw badRequest('Only dine-in orders have a table');

  const items = await buildItems({ restaurantId: req.restaurantId, outlet, orderType: b.type, userId: req.user._id }, b.items);

  const { order, kots, table } = await withTransaction(async (session) => {
    const { orderNo, businessDate: date } = await nextOrderNo(outlet, session);
    const order = new Order({
      restaurantId: req.restaurantId,
      outletId: outlet._id,
      orderNo,
      businessDate: date,
      type: b.type,
      source: 'pos',
      status: 'open',
      covers: b.covers ?? 0,
      customer: b.customer,
      note: b.note,
      items,
      captainId: req.user._id,
      createdBy: req.user._id,
      trackingToken: randomToken(16),
    });

    let table = null;
    if (b.tableId) {
      const t = await Table.findOne({ _id: b.tableId, restaurantId: req.restaurantId, outletId: outlet._id }).session(session);
      if (!t) throw badRequest('Unknown table', { tableId: ['Unknown table'] });
      table = await occupyTable(req.restaurantId, t._id, order._id, session);
      order.tableId = t._id;
      order.tableName = t.name;
    }

    const kots = b.sendKot ? await createKots(order, order.items, { outlet, userId: req.user._id }, session) : [];
    recalcOrder(order, outlet);
    await order.save({ session });
    if (table) table = await syncTableAmount(req, order, session);
    return { order, kots, table };
  });

  emitOrder(order, 'order.created');
  emitKots(kots);
  emitTable(table);
  created(res, order);
});

router.post('/orders/:id/items', idParams, can('orders.create'), idempotent, validate({
  body: z.strictObject({ items: zItems, sendKot: z.boolean().default(true) }),
}), async (req, res) => {
  const { outlet } = req;
  const { order, kots, table } = await withTransaction(async (session) => {
    const order = await findOrder(req, req.params.id, session);
    ensureOpen(order);
    const items = await buildItems({ restaurantId: req.restaurantId, outlet, orderType: order.type, userId: req.user._id }, req.body.items);
    const start = order.items.length;
    order.items.push(...items);
    const added = order.items.slice(start);
    if (order.status === 'awaiting_acceptance') order.status = 'open';
    const kots = req.body.sendKot ? await createKots(order, added, { outlet, userId: req.user._id }, session) : [];
    recalcOrder(order, outlet);
    await order.save({ session });
    return { order, kots, table: await syncTableAmount(req, order, session) };
  });

  emitOrder(order);
  emitKots(kots);
  emitTable(table);
  ok(res, order);
});

// Send KOT for items saved without one (sendKot: false).
router.post('/orders/:id/kot', idParams, can('orders.create'), async (req, res) => {
  const { order, kots } = await withTransaction(async (session) => {
    const order = await findOrder(req, req.params.id, session);
    ensureOpen(order);
    const pending = activeItems(order).filter((i) => !i.kotId);
    if (!pending.length) throw conflict('NOTHING_TO_SEND', 'All items are already sent to the kitchen');
    const kots = await createKots(order, pending, { outlet: req.outlet, userId: req.user._id }, session);
    await order.save({ session });
    return { order, kots };
  });
  emitOrder(order);
  emitKots(kots);
  ok(res, kots);
});

router.post('/orders/:id/items/:itemId/cancel', can('orders.cancelItem'), validate({
  params: z.strictObject({ id: zId, itemId: zId }),
  body: z.strictObject({ qty: zQty, reason: z.string().trim().min(3).max(200) }),
}), async (req, res) => {
  const { outlet } = req;
  const { order, kots, table } = await withTransaction(async (session) => {
    const order = await findOrder(req, req.params.id, session);
    ensureOpen(order);
    const item = order.items.id(req.params.itemId);
    if (!item || item.status === 'cancelled') throw notFound('Item');
    if (req.body.qty > item.qty) throw badRequest(`Only ${item.qty} left on this order`);

    const { qty, reason } = req.body;
    const sentToKitchen = Boolean(item.kotId);
    const kots = sentToKitchen
      ? await createKots(order, [item], { outlet, userId: req.user._id, type: 'cancel', qtyOf: () => qty }, session)
      : [];

    item.qty = Math.round((item.qty - qty) * 1000) / 1000;
    item.cancelledQty += qty;
    item.cancelReason = reason;
    if (item.qty === 0) item.status = 'cancelled';
    recalcOrder(order, outlet);
    await order.save({ session });

    if (sentToKitchen) {
      await audit(req, 'order.item_cancel', {
        entity: 'Order', entityId: order._id, details: { orderNo: order.orderNo, item: item.name, qty, reason },
      }, session);
    }
    return { order, kots, table: await syncTableAmount(req, order, session) };
  });

  emitOrder(order);
  emitKots(kots);
  emitTable(table);
  ok(res, order);
});

router.patch('/orders/:id', idParams, can('orders.create'), validate({
  body: z.strictObject({
    covers: z.number().int().min(0).max(100).optional(),
    customer: zCustomer.optional(),
    note: z.string().trim().max(200).optional(),
    captainId: zId.optional(),
  }),
}), async (req, res) => {
  const order = await findOrder(req, req.params.id);
  ensureOpen(order);
  if (req.body.captainId && !(await User.exists({ _id: req.body.captainId, restaurantId: req.restaurantId, isActive: true }))) {
    throw badRequest('Unknown staff member', { captainId: ['Unknown staff member'] });
  }
  order.set(req.body);
  await order.save();
  emitOrder(order);
  ok(res, order);
});

// --- QR order acceptance ----------------------------------------------------

router.post('/orders/:id/accept', idParams, can('orders.accept'), async (req, res) => {
  const { outlet } = req;
  const { order, kots, table } = await withTransaction(async (session) => {
    const order = await findOrder(req, req.params.id, session);
    ensureOpen(order);
    const waiting = order.items.filter((i) => i.status === 'awaiting_acceptance');
    if (!waiting.length) throw conflict('NOTHING_TO_ACCEPT', 'No items are waiting for acceptance');
    waiting.forEach((i) => { i.status = 'active'; });
    order.status = 'open';
    if (!order.captainId) order.captainId = req.user._id;
    const kots = await createKots(order, waiting, { outlet, userId: req.user._id }, session);
    recalcOrder(order, outlet);
    await order.save({ session });
    return { order, kots, table: await syncTableAmount(req, order, session) };
  });

  emitOrder(order);
  emitKots(kots);
  emitTable(table);
  ok(res, order);
});

router.post('/orders/:id/reject', idParams, can('orders.accept'), validate({
  body: z.strictObject({ reason: z.string().trim().min(3).max(200) }),
}), async (req, res) => {
  const { order, table } = await withTransaction(async (session) => {
    const order = await findOrder(req, req.params.id, session);
    ensureOpen(order);
    const waiting = order.items.filter((i) => i.status === 'awaiting_acceptance');
    if (!waiting.length) throw conflict('NOTHING_TO_REJECT', 'No items are waiting for acceptance');
    waiting.forEach((i) => { i.status = 'cancelled'; i.cancelReason = req.body.reason; });

    let table = null;
    if (!activeItems(order).length) {
      order.status = 'cancelled';
      order.cancelReason = req.body.reason;
      if (order.tableId) table = await freeTable(req.restaurantId, order.tableId, session);
    }
    recalcOrder(order, req.outlet);
    await order.save({ session });
    await audit(req, 'order.reject', { entity: 'Order', entityId: order._id, details: { orderNo: order.orderNo, reason: req.body.reason } }, session);
    return { order, table };
  });

  emitOrder(order);
  emitTable(table);
  ok(res, order);
});

router.post('/orders/:id/cancel', idParams, can('orders.cancelItem'), validate({
  body: z.strictObject({ reason: z.string().trim().min(3).max(200), approval: zApproval }),
}), async (req, res) => {
  const existing = await findOrder(req, req.params.id);
  ensureOpen(existing);
  const sent = existing.items.some((i) => i.kotId && i.status === 'active');
  // Food already sent to the kitchen costs money: same bar as voiding a bill.
  const approvedBy = sent ? await requireApproval(req, { permission: 'bills.void', approval: req.body.approval }) : null;

  const { order, kots, table } = await withTransaction(async (session) => {
    const order = await findOrder(req, req.params.id, session);
    ensureOpen(order);
    const sentItems = activeItems(order).filter((i) => i.kotId);
    const kots = await createKots(order, sentItems, { outlet: req.outlet, userId: req.user._id, type: 'cancel' }, session);
    order.items.forEach((i) => {
      if (i.status !== 'cancelled') {
        i.cancelledQty += i.qty;
        i.status = 'cancelled';
        i.cancelReason = req.body.reason;
      }
    });
    order.status = 'cancelled';
    order.cancelReason = req.body.reason;
    recalcOrder(order, req.outlet);
    await order.save({ session });
    const table = order.tableId ? await freeTable(req.restaurantId, order.tableId, session) : null;
    await audit(req, 'order.cancel', {
      entity: 'Order', entityId: order._id, approvedBy, details: { orderNo: order.orderNo, reason: req.body.reason, sentToKitchen: sent },
    }, session);
    return { order, kots, table };
  });

  emitOrder(order);
  emitKots(kots);
  emitTable(table);
  ok(res, order);
});

// --- KOTs / kitchen display -----------------------------------------------

const KOT_FLOW = ['pending', 'preparing', 'ready', 'served'];

router.get('/kots', validate({
  query: z.strictObject({
    status: z.string().regex(/^[a-z,]+$/).optional(),
    stationId: zId.optional(),
    date: z.iso.date().optional(),
  }),
}), async (req, res) => {
  const filter = {
    restaurantId: req.restaurantId,
    outletId: req.outletId,
    businessDate: req.query.date || businessDate(req.outlet.timezone),
  };
  if (req.query.status) filter.status = { $in: req.query.status.split(',') };
  if (req.query.stationId) filter.stationId = req.query.stationId;
  ok(res, await Kot.find(filter).sort({ createdAt: 1 }).limit(500));
});

router.patch('/kots/:id', idParams, can('kot.update'), validate({
  body: z.strictObject({ status: z.enum(KOT_FLOW) }),
}), async (req, res) => {
  const kot = await Kot.findOne({ _id: req.params.id, restaurantId: req.restaurantId, outletId: req.outletId });
  if (!kot) throw notFound('KOT');
  if (KOT_FLOW.indexOf(req.body.status) <= KOT_FLOW.indexOf(kot.status)) {
    throw conflict('INVALID_STATUS', `KOT is already ${kot.status}`);
  }
  kot.status = req.body.status;
  await kot.save();
  emit(
    [rooms.outlet(kot.outletId), kot.stationId && rooms.station(kot.stationId), rooms.order(kot.orderId)],
    'kot.updated',
    { id: String(kot._id), orderId: String(kot.orderId), kotNo: kot.kotNo, status: kot.status },
  );
  ok(res, kot);
});

router.post('/kots/:id/reprint', idParams, can('orders.create'), async (req, res) => {
  const kot = await Kot.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId, outletId: req.outletId },
    { $inc: { printCount: 1 } },
    { new: true },
  );
  if (!kot) throw notFound('KOT');
  await audit(req, 'kot.reprint', { entity: 'Kot', entityId: kot._id, details: { kotNo: kot.kotNo } });
  emit(rooms.outlet(kot.outletId), 'print', { kind: 'kot', id: String(kot._id), stationId: kot.stationId ? String(kot.stationId) : null, reprint: true });
  ok(res, kot);
});

export default router;
