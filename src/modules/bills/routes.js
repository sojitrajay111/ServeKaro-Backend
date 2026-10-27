import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, hasPermission } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { validate, zId, zMoney, zPaging, idParams } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { ok, created, list, escapeRegex } from '../../lib/http.js';
import { withTransaction } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { requireApproval } from '../../lib/approval.js';
import { computeBill, lineAmount, unitTotal } from '../../lib/money.js';
import { nextSeq } from '../../lib/counters.js';
import { businessDate, financialYear } from '../../lib/dates.js';
import { emit, rooms } from '../../lib/events.js';
import { zPhone } from '../../lib/phone.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { Order } from '../orders/model.js';
import { Table } from '../tables/model.js';
import { activeItems, serviceChargePercent, emitOrder } from '../orders/service.js';
import { Shift } from '../shifts/model.js';
import { updateTable, freeTable, occupyTable, emitTable } from '../tables/service.js';
import { Bill, PAYMENT_MODES } from './model.js';

const router = Router();
router.use('/bills', authenticate, outletScope);

const zDiscount = z.strictObject({
  kind: z.enum(['percent', 'flat']),
  value: z.number().positive(),
  reason: z.string().trim().min(2).max(100),
}).refine((d) => d.kind === 'flat' ? Number.isInteger(d.value) : d.value <= 100, {
  message: 'Percent must be ≤ 100; flat amount must be in paise',
  path: ['value'],
});
const zApproval = z.strictObject({ pin: z.string().regex(/^\d{4,6}$/) }).optional();
const zReason = z.string().trim().min(3).max(200);

const findBill = (req, id, session) =>
  Bill.findOne({ _id: id, restaurantId: req.restaurantId, outletId: req.outletId }).session(session || null);

// A cashier can give up to their role's maxDiscountPercent; more needs a manager PIN.
async function authorizeDiscount(req, discount, gross, approval) {
  if (!discount) return null;
  const percent = discount.kind === 'percent' ? discount.value : gross ? (discount.value * 100) / gross : 0;
  return requireApproval(req, {
    permission: 'bills.discount',
    allowed: (role) => role.isOwner || percent <= role.maxDiscountPercent,
    approval,
  });
}

function priceBill(bill, outlet, discount) {
  bill.amounts = computeBill(bill.lines.map((l) => ({ amount: l.amount, taxComponents: l.taxComponents })), {
    discount,
    pricesIncludeTax: outlet.pricesIncludeTax,
    serviceChargePercent: serviceChargePercent(outlet, bill.orderType),
    roundOff: outlet.roundOff,
  });
  bill.due = bill.amounts.total - bill.paid;
}

const netPaid = (bill) => bill.payments.reduce((s, p) => s + p.amount - p.refunded, 0);

async function openShift(req, session) {
  const shift = await Shift.findOne({ restaurantId: req.restaurantId, outletId: req.outletId, status: 'open' }).session(session || null);
  if (!shift) throw conflict('NO_OPEN_SHIFT', 'Open a shift before taking payments');
  return shift;
}

// Paid in full: bill closed, order settled, table freed.
async function settle(req, bill, session) {
  bill.status = 'paid';
  bill.due = 0;
  bill.settledAt = new Date();
  const order = await Order.findOneAndUpdate(
    { _id: bill.orderId, restaurantId: req.restaurantId },
    { status: 'settled' },
    { new: true, session },
  );
  const table = order?.tableId ? await freeTable(req.restaurantId, order.tableId, session) : null;
  return { order, table };
}

function emitBill(bill) {
  emit([rooms.outlet(bill.outletId), rooms.order(bill.orderId)], 'bill.updated', {
    id: String(bill._id), orderId: String(bill.orderId), billNo: bill.billNo,
    status: bill.status, total: bill.amounts.total, paid: bill.paid, due: bill.due,
  });
}

const after = ({ bill, order, table }) => {
  emitBill(bill);
  if (order) emitOrder(order);
  emitTable(table);
};

// --- create ---------------------------------------------------------------

router.post('/bills', can('bills.create'), idempotent, validate({
  body: z.strictObject({
    orderId: zId,
    discount: zDiscount.optional(),
    customer: z.strictObject({
      name: z.string().trim().max(80).optional(),
      phone: zPhone.optional(),
      gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN').optional(),
    }).optional(),
    approval: zApproval,
  }),
}), async (req, res) => {
  const { outlet } = req;
  const { discount, approval } = req.body;
  if (discount && !hasPermission(req, 'bills.discount') && !approval) throw forbidden('You cannot give discounts');

  const result = await withTransaction(async (session) => {
    const order = await Order.findOne({ _id: req.body.orderId, restaurantId: req.restaurantId, outletId: outlet._id }).session(session);
    if (!order) throw notFound('Order');
    if (order.status !== 'open') throw conflict('ORDER_NOT_OPEN', `Order is ${order.status}`);
    if (order.items.some((i) => i.status === 'awaiting_acceptance')) {
      throw conflict('ITEMS_AWAITING_ACCEPTANCE', 'Accept or reject the pending QR items first');
    }
    const items = activeItems(order);
    if (!items.length) throw conflict('EMPTY_ORDER', 'This order has no items');

    const lines = items.map((i) => ({
      itemId: i.itemId,
      name: i.variantName ? `${i.name} (${i.variantName})` : i.name,
      categoryId: i.categoryId,
      categoryName: i.categoryName,
      qty: i.qty,
      unitPrice: unitTotal(i.unitPrice, i.addons),
      amount: lineAmount(i),
      hsn: i.hsn,
      taxRate: i.taxComponents.reduce((s, c) => s + c.rate, 0),
      taxComponents: i.taxComponents,
    }));
    const gross = lines.reduce((s, l) => s + l.amount, 0);
    const approvedBy = await authorizeDiscount(req, discount, gross, approval);

    const date = businessDate(outlet.timezone);
    const fy = financialYear(date, outlet.financialYearStart);
    const seq = await nextSeq(`bill:${outlet._id}:${fy}`, session);

    const bill = new Bill({
      restaurantId: req.restaurantId,
      outletId: outlet._id,
      billNo: `${outlet.billPrefix}/${fy}/${String(seq).padStart(6, '0')}`,
      seq,
      financialYear: fy,
      businessDate: date,
      orderId: order._id,
      orderNo: order.orderNo,
      orderType: order.type,
      tableName: order.tableName,
      lines,
      customer: { ...order.toObject().customer, ...req.body.customer },
      createdBy: req.user._id,
    });
    priceBill(bill, outlet, discount);
    if (discount) {
      bill.discounts = [{ ...discount, amount: bill.amounts.discount, appliedBy: req.user._id, approvedBy }];
    }

    order.status = 'billed';
    order.billId = bill._id;
    await order.save({ session });

    let table = null;
    let settled = {};
    if (bill.amounts.total === 0) {
      settled = await settle(req, bill, session); // e.g. 100% discount
    } else if (order.tableId) {
      table = await updateTable(req.restaurantId, order.tableId, { status: 'billed', amount: bill.amounts.total }, session);
    }
    await bill.save({ session });

    if (discount) {
      await audit(req, 'bill.discount', {
        entity: 'Bill', entityId: bill._id, approvedBy, details: { billNo: bill.billNo, ...discount, amount: bill.amounts.discount },
      }, session);
    }
    const finalOrder = settled.order || order;
    return { bill, order: finalOrder, table: settled.table || table };
  });

  after(result);
  emit(rooms.outlet(outlet._id), 'print', { kind: 'bill', id: String(result.bill._id) });
  created(res, result.bill);
});

// --- read -----------------------------------------------------------------

router.get('/bills', can('reports.view'), validate({
  query: z.strictObject({
    status: z.enum(['unpaid', 'partly_paid', 'paid', 'void']).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    q: z.string().trim().max(30).optional(),
    ...zPaging,
  }),
}), async (req, res) => {
  const { status, from, to, q, page, limit } = req.query;
  const filter = { restaurantId: req.restaurantId, outletId: req.outletId };
  if (status) filter.status = status;
  if (from || to) filter.businessDate = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (q) filter.billNo = new RegExp(`${escapeRegex(q)}$`, 'i');
  const [bills, total] = await Promise.all([
    Bill.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Bill.countDocuments(filter),
  ]);
  list(res, bills, { page, limit, total });
});

router.get('/bills/:id', idParams, async (req, res) => {
  const bill = await findBill(req, req.params.id);
  if (!bill) throw notFound('Bill');
  ok(res, bill);
});

// --- change discount (before any payment) -------------------------------

router.patch('/bills/:id/discount', idParams, can('bills.discount'), validate({
  body: z.strictObject({ discount: zDiscount.nullable(), approval: zApproval }),
}), async (req, res) => {
  const result = await withTransaction(async (session) => {
    const bill = await findBill(req, req.params.id, session);
    if (!bill) throw notFound('Bill');
    if (bill.status !== 'unpaid') throw conflict('BILL_HAS_PAYMENTS', 'Discount can only change before payment');

    const { discount, approval } = req.body;
    const gross = bill.lines.reduce((s, l) => s + l.amount, 0);
    const approvedBy = await authorizeDiscount(req, discount, gross, approval);
    priceBill(bill, req.outlet, discount || undefined);
    bill.discounts = discount ? [{ ...discount, amount: bill.amounts.discount, appliedBy: req.user._id, approvedBy }] : [];

    let settled = {};
    let table = null;
    if (bill.amounts.total === 0) settled = await settle(req, bill, session);
    else {
      const order = await Order.findOne({ _id: bill.orderId, restaurantId: req.restaurantId }).session(session);
      if (order?.tableId) table = await updateTable(req.restaurantId, order.tableId, { amount: bill.amounts.total }, session);
    }
    await bill.save({ session });
    await audit(req, 'bill.discount', {
      entity: 'Bill', entityId: bill._id, approvedBy, details: { billNo: bill.billNo, discount, amount: bill.amounts.discount },
    }, session);
    return { bill, order: settled.order, table: settled.table || table };
  });
  after(result);
  ok(res, result.bill);
});

// --- payments -------------------------------------------------------------

router.post('/bills/:id/payments', idParams, can('payments.collect'), idempotent, validate({
  body: z.strictObject({
    mode: z.enum(PAYMENT_MODES),
    amount: zMoney.min(1),
    reference: z.string().trim().max(60).optional(),
  }),
}), async (req, res) => {
  const result = await withTransaction(async (session) => {
    const shift = await openShift(req, session);
    const bill = await findBill(req, req.params.id, session);
    if (!bill) throw notFound('Bill');
    if (!['unpaid', 'partly_paid'].includes(bill.status)) throw conflict('BILL_NOT_PAYABLE', `Bill is already ${bill.status}`);
    if (req.body.amount > bill.due) throw badRequest(`Only ₹${(bill.due / 100).toFixed(2)} is due`);
    if (req.body.mode === 'due' && !bill.customer?.phone) {
      throw badRequest('Add the customer phone number to put this on credit');
    }

    bill.payments.push({ ...req.body, shiftId: shift._id, receivedBy: req.user._id });
    bill.paid += req.body.amount;
    bill.due -= req.body.amount;

    let settled = {};
    if (bill.due === 0) settled = await settle(req, bill, session);
    else bill.status = 'partly_paid';
    await bill.save({ session });
    return { bill, ...settled };
  });
  after(result);
  created(res, result.bill);
});

router.post('/bills/:id/payments/:paymentId/refund', can('payments.refund'), validate({
  params: z.strictObject({ id: zId, paymentId: zId }),
  body: z.strictObject({ amount: zMoney.min(1), reason: zReason }),
}), async (req, res) => {
  const result = await withTransaction(async (session) => {
    const shift = await openShift(req, session);
    const bill = await findBill(req, req.params.id, session);
    const payment = bill?.payments.id(req.params.paymentId);
    if (!payment) throw notFound('Payment');
    if (bill.status === 'void') throw conflict('BILL_VOID', 'Bill is void');
    if (req.body.amount > payment.amount - payment.refunded) throw badRequest('Refund is more than what was paid');

    payment.refunded += req.body.amount;
    bill.refunds.push({ paymentId: payment._id, mode: payment.mode, ...req.body, shiftId: shift._id, by: req.user._id });
    await bill.save({ session });
    await audit(req, 'payment.refund', {
      entity: 'Bill', entityId: bill._id, details: { billNo: bill.billNo, mode: payment.mode, ...req.body },
    }, session);
    return { bill };
  });
  after(result);
  ok(res, result.bill);
});

// --- void / complimentary / reprint -----------------------------------------

router.post('/bills/:id/void', idParams, validate({
  body: z.strictObject({ reason: zReason, approval: zApproval, reopenOrder: z.boolean().default(false) }),
}), async (req, res) => {
  const approvedBy = await requireApproval(req, { permission: 'bills.void', approval: req.body.approval });

  const result = await withTransaction(async (session) => {
    const bill = await findBill(req, req.params.id, session);
    if (!bill) throw notFound('Bill');
    if (bill.status === 'void') throw conflict('BILL_VOID', 'Bill is already void');
    // Money must be returned first so cash and reports stay right.
    if (netPaid(bill) > 0) throw conflict('PAYMENTS_EXIST', 'Refund the payments on this bill before voiding it');

    bill.status = 'void';
    bill.due = 0;
    bill.voidReason = req.body.reason;
    bill.voidedBy = req.user._id;
    bill.voidedAt = new Date();
    await bill.save({ session });

    const order = await Order.findOne({ _id: bill.orderId, restaurantId: req.restaurantId }).session(session);
    let table = null;
    // The table may have been freed (bill was settled) and even re-seated since.
    const t = order.tableId && await Table.findOne({ _id: order.tableId, restaurantId: req.restaurantId }).session(session);
    const stillOurs = t && String(t.orderId) === String(order._id);
    if (req.body.reopenOrder) {
      order.status = 'open';
      order.billId = null;
      if (t) {
        table = stillOurs
          ? await updateTable(req.restaurantId, t._id, { status: 'occupied', amount: order.amounts.total }, session)
          : await occupyTable(req.restaurantId, t._id, order._id, session);
      }
    } else {
      order.status = 'cancelled';
      order.cancelReason = `Bill ${bill.billNo} voided: ${req.body.reason}`;
      if (stillOurs) table = await freeTable(req.restaurantId, t._id, session);
    }
    await order.save({ session });
    await audit(req, 'bill.void', {
      entity: 'Bill', entityId: bill._id, approvedBy,
      details: { billNo: bill.billNo, total: bill.amounts.total, reason: req.body.reason, reopenOrder: req.body.reopenOrder },
    }, session);
    return { bill, order, table };
  });
  after(result);
  ok(res, result.bill);
});

router.post('/bills/:id/complimentary', idParams, validate({
  body: z.strictObject({ reason: zReason, approval: zApproval }),
}), async (req, res) => {
  const approvedBy = await requireApproval(req, { permission: 'bills.complimentary', approval: req.body.approval });

  const result = await withTransaction(async (session) => {
    const bill = await findBill(req, req.params.id, session);
    if (!bill) throw notFound('Bill');
    if (bill.status !== 'unpaid') throw conflict('BILL_HAS_PAYMENTS', 'Only unpaid bills can be made complimentary');
    bill.isComplimentary = true;
    bill.voidReason = req.body.reason;
    const settled = await settle(req, bill, session);
    await bill.save({ session });
    await audit(req, 'bill.complimentary', {
      entity: 'Bill', entityId: bill._id, approvedBy, details: { billNo: bill.billNo, total: bill.amounts.total, reason: req.body.reason },
    }, session);
    return { bill, ...settled };
  });
  after(result);
  ok(res, result.bill);
});

router.post('/bills/:id/reprint', idParams, can('bills.reprint'), async (req, res) => {
  const bill = await Bill.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId, outletId: req.outletId },
    { $inc: { printCount: 1 } },
    { new: true },
  );
  if (!bill) throw notFound('Bill');
  await audit(req, 'bill.reprint', { entity: 'Bill', entityId: bill._id, details: { billNo: bill.billNo, printCount: bill.printCount } });
  emit(rooms.outlet(bill.outletId), 'print', { kind: 'bill', id: String(bill._id), duplicate: true });
  ok(res, bill);
});

export default router;
