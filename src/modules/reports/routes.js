import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { authenticate, can } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { validate, zId, zPaging } from '../../middleware/validate.js';
import { ok, list } from '../../lib/http.js';
import { businessDate } from '../../lib/dates.js';
import { badRequest } from '../../lib/errors.js';
import { AuditLog } from '../audit/model.js';
import { dashboard, salesSummary, paymentsByMode, itemSales, taxReport } from './service.js';

const router = Router();
router.use(['/reports', '/audit-logs'], authenticate, can('reports.view'), outletScope);

const rangeQuery = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  format: z.enum(['json', 'csv']).default('json'),
  categoryId: zId.optional(),
}).refine((q) => q.from <= q.to, { message: '"from" must be before "to"', path: ['from'] });

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  // Leading = + - @ would run as a formula in Excel.
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

const send = (res, rows, format, name) => {
  if (format === 'csv') {
    if (!Array.isArray(rows)) throw badRequest('CSV is not available for this report');
    res.type('text/csv').attachment(`${name}.csv`).send(toCsv(rows));
  } else ok(res, rows);
};

const report = (path, fn) => router.get(`/reports/${path}`, validate({ query: rangeQuery }), async (req, res) => {
  const { from, to, format } = req.query;
  send(res, await fn(req, from, to, req.query), format, `${path}-${from}-${to}`);
});

router.get('/reports/dashboard', validate({ query: z.strictObject({ date: z.iso.date().optional() }) }), async (req, res) => {
  const tz = req.outlet.timezone;
  ok(res, await dashboard(req, req.query.date || businessDate(tz), tz));
});

report('sales', (req, from, to) => salesSummary(req, from, to, '$businessDate'));
report('payments', paymentsByMode);
report('items', (req, from, to, q) => itemSales(req, from, to, {
  categoryId: q.categoryId && new mongoose.Types.ObjectId(q.categoryId),
}));
report('categories', (req, from, to) => itemSales(req, from, to, { by: 'category' }));
report('tax', taxReport);

router.get('/audit-logs', validate({
  query: z.strictObject({
    action: z.string().regex(/^[a-z_.]+$/).optional(),
    userId: zId.optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    ...zPaging,
  }),
}), async (req, res) => {
  const { action, userId, from, to, page, limit } = req.query;
  const filter = { restaurantId: req.restaurantId, outletId: req.outletId };
  if (action) filter.action = action;
  if (userId) filter.userId = userId;
  if (from || to) {
    filter.createdAt = {
      ...(from && { $gte: new Date(`${from}T00:00:00Z`) }),
      ...(to && { $lte: new Date(`${to}T23:59:59Z`) }),
    };
  }
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  list(res, logs, { page, limit, total });
});

export default router;
