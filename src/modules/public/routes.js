import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { publicOrderLimiter, tableOrderLimiter, callWaiterLimiter } from '../../middleware/limits.js';
import { ok, created } from '../../lib/http.js';
import { withTransaction } from '../../lib/db.js';
import { randomToken } from '../../lib/crypto.js';
import { emit, rooms } from '../../lib/events.js';
import { zPhone } from '../../lib/phone.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { Outlet, publicOutlet } from '../outlets/model.js';
import { Table } from '../tables/model.js';
import { occupyTable, updateTable, emitTable } from '../tables/service.js';
import { loadMenu } from '../menu/service.js';
import { Order, Kot } from '../orders/model.js';
import { Bill } from '../bills/model.js';
import { buildItems, createKots, recalcOrder, nextOrderNo, emitOrder, emitKots } from '../orders/service.js';
import { zItemInput } from '../orders/routes.js';

const router = Router();

const zQrToken = z.string().regex(/^[\w-]{16,64}$/);
const qrParams = validate({ params: z.strictObject({ qrToken: zQrToken }) });

async function resolveTable(qrToken, session) {
  const table = await Table.findOne({ qrToken, isActive: true }).setOptions({ crossTenant: true }).session(session || null);
  if (!table) throw notFound('Table');
  const outlet = await Outlet.findOne({ _id: table.outletId, restaurantId: table.restaurantId }).session(session || null);
  if (!outlet) throw notFound('Table');
  return { table, outlet };
}

router.get('/t/:qrToken', qrParams, async (req, res) => {
  const { table, outlet } = await resolveTable(req.params.qrToken);
  ok(res, {
    outlet: publicOutlet(outlet),
    table: { id: String(table._id), name: table.name },
    menu: await loadMenu(outlet.restaurantId, outlet._id, { forCustomers: true }),
  });
});

router.get('/outlets/:slug/menu', validate({
  params: z.strictObject({ slug: z.string().regex(/^[a-z0-9-]{3,50}$/) }),
}), async (req, res) => {
  const outlet = await Outlet.findOne({ slug: req.params.slug }).setOptions({ crossTenant: true });
  if (!outlet) throw notFound('Restaurant');
  ok(res, { outlet: publicOutlet(outlet), menu: await loadMenu(outlet.restaurantId, outlet._id, { forCustomers: true }) });
});

// Dine-in QR order. If the table already has an open order (friends ordering
// from their own phones), the items join it as a new round.
router.post('/orders', publicOrderLimiter, tableOrderLimiter, idempotent, validate({
  body: z.strictObject({
    qrToken: zQrToken,
    customer: z.strictObject({ name: z.string().trim().min(2).max(60), phone: zPhone }),
    items: z.array(zItemInput).min(1).max(30),
    note: z.string().trim().max(200).optional(),
  }),
}), async (req, res) => {
  const { qrToken, customer, items: inputs, note } = req.body;

  const { order, kots, table } = await withTransaction(async (session) => {
    const { table, outlet } = await resolveTable(qrToken, session);
    if (!outlet.isOpen || !outlet.qrOrdering.enabled) {
      throw new AppError(409, 'ORDERING_CLOSED', 'Ordering from the table is closed right now. Please ask the staff');
    }
    const needsAcceptance = outlet.qrOrdering.requireAcceptance;
    const items = await buildItems({
      restaurantId: outlet.restaurantId, outlet, orderType: 'dine_in',
      status: needsAcceptance ? 'awaiting_acceptance' : 'active',
    }, inputs);

    let order;
    let fresh = false;
    if (table.status === 'billed') throw conflict('TABLE_BILLED', 'The bill for this table is ready. Ask the staff to add more');
    if (table.status === 'occupied' && table.orderId) {
      order = await Order.findOne({ _id: table.orderId, restaurantId: outlet.restaurantId }).session(session);
      if (!order || !['open', 'awaiting_acceptance'].includes(order.status)) throw conflict('TABLE_BUSY', 'Please ask the staff');
    } else {
      fresh = true;
      const { orderNo, businessDate } = await nextOrderNo(outlet, session);
      order = new Order({
        restaurantId: outlet.restaurantId,
        outletId: outlet._id,
        orderNo,
        businessDate,
        type: 'dine_in',
        source: 'qr',
        status: needsAcceptance ? 'awaiting_acceptance' : 'open',
        tableId: table._id,
        tableName: table.name,
        customer,
        note,
        items: [],
        trackingToken: randomToken(16),
      });
      await occupyTable(outlet.restaurantId, table._id, order._id, session);
    }

    const start = order.items.length;
    order.items.push(...items);
    const added = order.items.slice(start);
    if (!fresh && note) order.note = [order.note, note].filter(Boolean).join(' | ');

    const kots = needsAcceptance ? [] : await createKots(order, added, { outlet }, session);
    recalcOrder(order, outlet);
    await order.save({ session });
    const t = await updateTable(outlet.restaurantId, table._id, { amount: order.amounts.total }, session);
    return { order, kots, table: t, fresh };
  });

  emitOrder(order, 'order.created');
  emitKots(kots);
  emitTable(table);
  created(res, {
    orderId: String(order._id),
    orderNo: order.orderNo,
    trackingToken: order.trackingToken,
    status: order.status,
  });
});

router.get('/orders/:trackingToken', validate({
  params: z.strictObject({ trackingToken: z.string().regex(/^[\w-]{16,64}$/) }),
}), async (req, res) => {
  const order = await Order.findOne({ trackingToken: req.params.trackingToken }).setOptions({ crossTenant: true });
  if (!order) throw notFound('Order');
  const [kots, bill] = await Promise.all([
    Kot.find({ restaurantId: order.restaurantId, orderId: order._id, type: 'new' }).select('status').lean(),
    order.billId ? Bill.findOne({ _id: order.billId, restaurantId: order.restaurantId }) : null,
  ]);
  const kotStatus = new Map(kots.map((k) => [String(k._id), k.status]));

  ok(res, {
    orderId: String(order._id),
    orderNo: order.orderNo,
    status: order.status,
    tableName: order.tableName,
    items: order.items.map((i) => ({
      name: i.name,
      variantName: i.variantName,
      addons: i.addons.map((a) => a.name),
      qty: i.qty,
      status: i.status,
      kitchenStatus: i.kotId ? kotStatus.get(String(i.kotId)) || 'pending' : null,
    })),
    amounts: order.amounts,
    bill: bill && { billNo: bill.billNo, status: bill.status, total: bill.amounts.total, paid: bill.paid, due: bill.due },
    createdAt: order.createdAt,
  });
});

router.post('/t/:qrToken/call-waiter', qrParams, callWaiterLimiter, validate({
  body: z.strictObject({ reason: z.enum(['waiter', 'bill', 'water']) }),
}), async (req, res) => {
  const { table } = await resolveTable(req.params.qrToken);
  emit(rooms.outlet(table.outletId), 'waiter.called', {
    tableId: String(table._id), tableName: table.name, reason: req.body.reason, at: new Date(),
  });
  ok(res);
});

export default router;
