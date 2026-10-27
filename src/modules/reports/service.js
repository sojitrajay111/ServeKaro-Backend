import { Bill } from '../bills/model.js';
import { Order } from '../orders/model.js';
import { Table } from '../tables/model.js';
import { Shift } from '../shifts/model.js';

// Sales = paid, non-complimentary bills. Void and NC are reported separately.
const salesMatch = (req, from, to) => ({
  restaurantId: req.restaurantId,
  outletId: req.outletId,
  businessDate: { $gte: from, $lte: to },
  status: 'paid',
  isComplimentary: false,
});

const taxTotal = { $sum: '$amounts.taxes.amount' };

export async function salesSummary(req, from, to, groupBy = null) {
  return Bill.aggregate([
    { $match: salesMatch(req, from, to) },
    {
      $group: {
        _id: groupBy,
        bills: { $sum: 1 },
        gross: { $sum: '$amounts.subtotal' },
        discount: { $sum: '$amounts.discount' },
        serviceCharge: { $sum: '$amounts.serviceCharge' },
        tax: { $sum: taxTotal },
        roundOff: { $sum: '$amounts.roundOff' },
        net: { $sum: '$amounts.total' },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, key: '$_id', bills: 1, gross: 1, discount: 1, serviceCharge: 1, tax: 1, roundOff: 1, net: 1 } },
  ]);
}

export function paymentsByMode(req, from, to) {
  return Bill.aggregate([
    { $match: salesMatch(req, from, to) },
    { $unwind: '$payments' },
    { $group: { _id: '$payments.mode', count: { $sum: 1 }, amount: { $sum: '$payments.amount' }, refunded: { $sum: '$payments.refunded' } } },
    { $project: { _id: 0, mode: '$_id', count: 1, amount: 1, refunded: 1, net: { $subtract: ['$amount', '$refunded'] } } },
    { $sort: { net: -1 } },
  ]);
}

export function itemSales(req, from, to, { by = 'item', categoryId, limit = 1000 } = {}) {
  const key = by === 'category' ? { id: '$lines.categoryId', name: '$lines.categoryName' } : { id: '$lines.itemId', name: '$lines.name' };
  return Bill.aggregate([
    { $match: salesMatch(req, from, to) },
    { $unwind: '$lines' },
    ...(categoryId ? [{ $match: { 'lines.categoryId': categoryId } }] : []),
    { $group: { _id: key, qty: { $sum: '$lines.qty' }, amount: { $sum: '$lines.amount' } } },
    { $sort: { amount: -1 } },
    { $limit: limit },
    { $project: { _id: 0, id: '$_id.id', name: '$_id.name', qty: 1, amount: 1 } },
  ]);
}

// GST summary by rate and by HSN, for GSTR-1.
export async function taxReport(req, from, to) {
  const match = salesMatch(req, from, to);
  const [byRate, byHsn] = await Promise.all([
    Bill.aggregate([
      { $match: match },
      { $unwind: '$amounts.taxes' },
      {
        $group: {
          _id: { name: '$amounts.taxes.name', rate: '$amounts.taxes.rate' },
          taxable: { $sum: '$amounts.taxes.taxable' },
          amount: { $sum: '$amounts.taxes.amount' },
        },
      },
      { $sort: { '_id.rate': 1, '_id.name': 1 } },
      { $project: { _id: 0, name: '$_id.name', rate: '$_id.rate', taxable: 1, amount: 1 } },
    ]),
    Bill.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      {
        $group: {
          _id: { hsn: '$lines.hsn', rate: '$lines.taxRate' },
          qty: { $sum: '$lines.qty' },
          value: { $sum: '$lines.amount' },
        },
      },
      { $sort: { '_id.hsn': 1, '_id.rate': 1 } },
      { $project: { _id: 0, hsn: '$_id.hsn', rate: '$_id.rate', qty: 1, value: 1 } },
    ]),
  ]);
  return { byRate, byHsn };
}

export async function exceptions(req, from, to) {
  const base = { restaurantId: req.restaurantId, outletId: req.outletId, businessDate: { $gte: from, $lte: to } };
  const [voids, nc] = await Promise.all([
    Bill.aggregate([{ $match: { ...base, status: 'void' } }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amounts.total' } } }]),
    Bill.aggregate([{ $match: { ...base, isComplimentary: true } }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amounts.total' } } }]),
  ]);
  const pick = (r) => ({ count: r[0]?.count || 0, amount: r[0]?.amount || 0 });
  return { void: pick(voids), complimentary: pick(nc) };
}

export async function dayEnd(req, date) {
  const [sales] = await salesSummary(req, date, date);
  const [payments, tax, exc, shifts] = await Promise.all([
    paymentsByMode(req, date, date),
    taxReport(req, date, date),
    exceptions(req, date, date),
    Shift.find({ restaurantId: req.restaurantId, outletId: req.outletId, businessDate: date }).sort({ openedAt: 1 }),
  ]);
  return {
    date,
    sales: sales || { bills: 0, gross: 0, discount: 0, serviceCharge: 0, tax: 0, roundOff: 0, net: 0 },
    payments,
    taxes: tax.byRate,
    ...exc,
    shifts: shifts.map((s) => ({
      id: String(s._id), status: s.status, openedAt: s.openedAt, closedAt: s.closedAt,
      openingCash: s.openingCash, expectedCash: s.expectedCash, countedCash: s.countedCash, difference: s.difference,
    })),
  };
}

export async function dashboard(req, date, timezone) {
  const [[sales], top, byHour, orders, running] = await Promise.all([
    salesSummary(req, date, date),
    itemSales(req, date, date, { limit: 5 }),
    Bill.aggregate([
      { $match: salesMatch(req, date, date) },
      { $group: { _id: { $hour: { date: '$settledAt', timezone } }, amount: { $sum: '$amounts.total' }, bills: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, hour: '$_id', amount: 1, bills: 1 } },
    ]),
    Order.aggregate([
      { $match: { restaurantId: req.restaurantId, outletId: req.outletId, businessDate: date, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, count: { $sum: 1 }, covers: { $sum: '$covers' } } },
    ]),
    Table.aggregate([
      { $match: { restaurantId: req.restaurantId, outletId: req.outletId, status: { $ne: 'free' } } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);
  const net = sales?.net || 0;
  const bills = sales?.bills || 0;
  return {
    date,
    sales: net,
    bills,
    avgBill: bills ? Math.round(net / bills) : 0,
    orders: orders[0]?.count || 0,
    covers: orders[0]?.covers || 0,
    runningTables: running[0]?.count || 0,
    runningAmount: running[0]?.amount || 0,
    topItems: top,
    byHour,
  };
}
