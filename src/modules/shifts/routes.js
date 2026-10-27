import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { validate, zMoney, zPaging } from '../../middleware/validate.js';
import { ok, created, list } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { businessDate } from '../../lib/dates.js';
import { conflict } from '../../lib/errors.js';
import { Bill } from '../bills/model.js';
import { Shift } from './model.js';
import { dayEnd } from '../reports/service.js';

const router = Router();
router.use(['/shifts', '/day-end'], authenticate, outletScope);

const scope = (req) => ({ restaurantId: req.restaurantId, outletId: req.outletId });

async function currentShift(req) {
  const shift = await Shift.findOne({ ...scope(req), status: 'open' });
  if (!shift) throw conflict('NO_OPEN_SHIFT', 'No shift is open');
  return shift;
}

// Cash that should be in the drawer: opening + cash taken - cash refunded + cash in - cash out.
export async function expectedCash(req, shift) {
  const [row] = await Bill.aggregate([
    { $match: { ...scope(req), $or: [{ 'payments.shiftId': shift._id }, { 'refunds.shiftId': shift._id }] } },
    {
      $project: {
        taken: {
          $sum: {
            $map: {
              input: { $filter: { input: '$payments', cond: { $and: [{ $eq: ['$$this.shiftId', shift._id] }, { $eq: ['$$this.mode', 'cash'] }] } } },
              in: '$$this.amount',
            },
          },
        },
        refunded: {
          $sum: {
            $map: {
              input: { $filter: { input: '$refunds', cond: { $and: [{ $eq: ['$$this.shiftId', shift._id] }, { $eq: ['$$this.mode', 'cash'] }] } } },
              in: '$$this.amount',
            },
          },
        },
      },
    },
    { $group: { _id: null, taken: { $sum: '$taken' }, refunded: { $sum: '$refunded' } } },
  ]);
  const moves = shift.cashMovements.reduce((s, m) => s + (m.kind === 'in' ? m.amount : -m.amount), 0);
  const cashSales = (row?.taken || 0) - (row?.refunded || 0);
  return { openingCash: shift.openingCash, cashSales, cashMovements: moves, expected: shift.openingCash + cashSales + moves };
}

router.get('/shifts/current', async (req, res) => {
  const shift = await Shift.findOne({ ...scope(req), status: 'open' });
  ok(res, shift ? { ...shift.toJSON(), cash: await expectedCash(req, shift) } : null);
});

router.post('/shifts/open', can('shift.manage'), validate({
  body: z.strictObject({ openingCash: zMoney }),
}), async (req, res) => {
  try {
    const shift = await Shift.create({
      ...scope(req),
      businessDate: businessDate(req.outlet.timezone),
      openedBy: req.user._id,
      openingCash: req.body.openingCash,
    });
    created(res, shift);
  } catch (err) {
    if (err.code === 11000) throw conflict('SHIFT_ALREADY_OPEN', 'A shift is already open');
    throw err;
  }
});

router.post('/shifts/current/cash', can('shift.manage'), validate({
  body: z.strictObject({ kind: z.enum(['in', 'out']), amount: zMoney.min(1), reason: z.string().trim().min(3).max(100) }),
}), async (req, res) => {
  const shift = await currentShift(req);
  shift.cashMovements.push({ ...req.body, by: req.user._id });
  await shift.save();
  await audit(req, `shift.cash_${req.body.kind}`, { entity: 'Shift', entityId: shift._id, details: req.body });
  ok(res, { ...shift.toJSON(), cash: await expectedCash(req, shift) });
});

router.post('/shifts/current/close', can('shift.manage'), validate({
  body: z.strictObject({
    countedCash: zMoney,
    denominations: z.record(z.enum(['2000', '500', '200', '100', '50', '20', '10', '5', '2', '1']), z.number().int().min(0)).optional(),
    note: z.string().trim().max(200).optional(),
  }),
}), async (req, res) => {
  const shift = await currentShift(req);
  const cash = await expectedCash(req, shift);
  shift.set({
    status: 'closed',
    closedBy: req.user._id,
    closedAt: new Date(),
    expectedCash: cash.expected,
    countedCash: req.body.countedCash,
    difference: req.body.countedCash - cash.expected,
    denominations: req.body.denominations,
    note: req.body.note,
  });
  await shift.save();
  if (shift.difference !== 0) {
    await audit(req, 'shift.close_difference', {
      entity: 'Shift', entityId: shift._id, details: { expected: cash.expected, counted: shift.countedCash, difference: shift.difference },
    });
  }
  ok(res, { ...shift.toJSON(), cash });
});

router.get('/shifts', can('reports.view'), validate({ query: z.strictObject(zPaging) }), async (req, res) => {
  const { page, limit } = req.query;
  const [shifts, total] = await Promise.all([
    Shift.find(scope(req)).sort({ openedAt: -1 }).skip((page - 1) * limit).limit(limit),
    Shift.countDocuments(scope(req)),
  ]);
  list(res, shifts, { page, limit, total });
});

router.get('/day-end', can('reports.view'), validate({ query: z.strictObject({ date: z.iso.date().optional() }) }), async (req, res) => {
  ok(res, await dayEnd(req, req.query.date || businessDate(req.outlet.timezone)));
});

export default router;
