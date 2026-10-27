import { Router } from 'express';
import { z } from 'zod';
import env from '../../config/env.js';
import { authenticate, can } from '../../middleware/auth.js';
import { outletScope } from '../../middleware/outlet.js';
import { validate, zId, idParams } from '../../middleware/validate.js';
import { ok, created } from '../../lib/http.js';
import { withTransaction } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, badRequest } from '../../lib/errors.js';
import { Order } from '../orders/model.js';
import { recalcOrder, emitOrder } from '../orders/service.js';
import { Area, Table } from './model.js';
import { newQrToken, occupyTable, freeTable, updateTable, emitTable } from './service.js';

const router = Router();
router.use(['/areas', '/tables'], authenticate, outletScope);

const scope = (req) => ({ restaurantId: req.restaurantId, outletId: req.outletId });
const qrUrl = (t) => `${env.frontendUrl}/t/${t.qrToken}`;
const withQr = (t) => ({ ...t.toJSON(), qrUrl: qrUrl(t) });

// --- areas ----------------------------------------------------------------

const areaBody = z.strictObject({ name: z.string().trim().min(1).max(40), sortOrder: z.number().int().min(0).optional() });

router.get('/areas', async (req, res) => {
  ok(res, await Area.find(scope(req)).sort({ sortOrder: 1, name: 1 }));
});

router.post('/areas', can('tables.manage'), validate({ body: areaBody }), async (req, res) => {
  created(res, await Area.create({ ...scope(req), ...req.body }));
});

router.patch('/areas/:id', idParams, can('tables.manage'), validate({ body: areaBody.partial() }), async (req, res) => {
  const a = await Area.findOneAndUpdate({ _id: req.params.id, ...scope(req) }, req.body, { new: true });
  if (!a) throw notFound('Area');
  ok(res, a);
});

router.delete('/areas/:id', idParams, can('tables.manage'), async (req, res) => {
  if (await Table.exists({ ...scope(req), areaId: req.params.id })) {
    throw conflict('AREA_NOT_EMPTY', 'Move the tables in this area first');
  }
  await Area.deleteOne({ _id: req.params.id, ...scope(req) });
  ok(res);
});

// --- tables -----------------------------------------------------------------

const tableBody = z.strictObject({
  name: z.string().trim().min(1).max(20),
  areaId: zId.nullable().optional(),
  capacity: z.number().int().min(1).max(50).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

async function checkArea(req, areaId) {
  if (areaId && !(await Area.exists({ _id: areaId, ...scope(req) }))) {
    throw badRequest('Unknown area', { areaId: ['Unknown area'] });
  }
}

router.get('/tables', validate({ query: z.strictObject({ areaId: zId.optional() }) }), async (req, res) => {
  const filter = scope(req);
  if (req.query.areaId) filter.areaId = req.query.areaId;
  const tables = await Table.find(filter).sort({ sortOrder: 1, name: 1 });
  ok(res, tables.map(withQr));
});

router.post('/tables', can('tables.manage'), validate({ body: tableBody }), async (req, res) => {
  await checkArea(req, req.body.areaId);
  const table = await Table.create({ ...scope(req), ...req.body, qrToken: newQrToken() });
  created(res, withQr(table));
});

router.get('/tables/:id', idParams, async (req, res) => {
  const table = await Table.findOne({ _id: req.params.id, ...scope(req) });
  if (!table) throw notFound('Table');
  ok(res, withQr(table));
});

router.patch('/tables/:id', idParams, can('tables.manage'), validate({ body: tableBody.partial() }), async (req, res) => {
  await checkArea(req, req.body.areaId);
  const table = await Table.findOneAndUpdate({ _id: req.params.id, ...scope(req) }, req.body, { new: true });
  if (!table) throw notFound('Table');
  ok(res, withQr(table));
});

router.delete('/tables/:id', idParams, can('tables.manage'), async (req, res) => {
  const table = await Table.findOne({ _id: req.params.id, ...scope(req) });
  if (!table) throw notFound('Table');
  if (table.status !== 'free') throw conflict('TABLE_OCCUPIED', 'This table has an open order');
  await table.deleteOne();
  ok(res);
});

router.post('/tables/:id/qr/rotate', idParams, can('tables.manage'), async (req, res) => {
  const table = await Table.findOneAndUpdate({ _id: req.params.id, ...scope(req) }, { qrToken: newQrToken() }, { new: true });
  if (!table) throw notFound('Table');
  await audit(req, 'table.qr_rotate', { entity: 'Table', entityId: table._id, details: { name: table.name } });
  ok(res, withQr(table));
});

// Move the open order to another free table.
router.post('/tables/:id/transfer', idParams, can('orders.create'), validate({
  body: z.strictObject({ toTableId: zId }),
}), async (req, res) => {
  if (req.body.toTableId === req.params.id) throw badRequest('Pick a different table');

  const { order, from, to } = await withTransaction(async (session) => {
    const fromT = await Table.findOne({ _id: req.params.id, ...scope(req) }).session(session);
    if (!fromT || !fromT.orderId) throw conflict('NO_OPEN_ORDER', 'This table has no open order');
    const target = await Table.findOne({ _id: req.body.toTableId, ...scope(req) }).session(session);
    if (!target) throw notFound('Table');

    const o = await Order.findOne({ _id: fromT.orderId, restaurantId: req.restaurantId }).session(session);
    let toT = await occupyTable(req.restaurantId, target._id, o._id, session);
    toT = await updateTable(req.restaurantId, toT._id, { status: fromT.status, since: fromT.since, amount: fromT.amount }, session);
    const freed = await freeTable(req.restaurantId, fromT._id, session);

    o.tableId = toT._id;
    o.tableName = toT.name;
    await o.save({ session });
    await audit(req, 'table.transfer', { entity: 'Order', entityId: o._id, details: { from: fromT.name, to: toT.name } }, session);
    return { order: o, from: freed, to: toT };
  });

  emitTable(from);
  emitTable(to);
  emitOrder(order);
  ok(res, order);
});

// Merge open orders of several tables into the first one's order.
router.post('/tables/merge', can('orders.create'), validate({
  body: z.strictObject({ tableIds: z.array(zId).min(2).max(10) }),
}), async (req, res) => {
  const ids = [...new Set(req.body.tableIds)];
  if (ids.length < 2) throw badRequest('Pick at least two tables');

  const { target, freed } = await withTransaction(async (session) => {
    const tables = await Table.find({ _id: { $in: ids }, ...scope(req) }).session(session);
    if (tables.length !== ids.length) throw notFound('Table');
    const ordered = ids.map((id) => tables.find((t) => String(t._id) === id));
    if (ordered.some((t) => t.status !== 'occupied')) {
      throw conflict('TABLE_NOT_MERGEABLE', 'Only occupied tables that are not billed yet can be merged');
    }

    const orders = await Order.find({ _id: { $in: ordered.map((t) => t.orderId) }, restaurantId: req.restaurantId }).session(session);
    const byId = (id) => orders.find((o) => String(o._id) === String(id));
    const main = byId(ordered[0].orderId);
    const freedTables = [];

    for (const t of ordered.slice(1)) {
      const o = byId(t.orderId);
      main.items.push(...o.items.map((i) => i.toObject()));
      main.covers += o.covers;
      o.items = [];
      o.status = 'cancelled';
      o.cancelReason = `Merged into order #${main.orderNo}`;
      await o.save({ session });
      freedTables.push(await freeTable(req.restaurantId, t._id, session));
    }

    await recalcOrder(main, req.outlet);
    await main.save({ session });
    const mainTable = await updateTable(req.restaurantId, ordered[0]._id, { amount: main.amounts.total }, session);
    await audit(req, 'table.merge', {
      entity: 'Order', entityId: main._id, details: { tables: ordered.map((t) => t.name) },
    }, session);
    return { target: { order: main, table: mainTable }, freed: freedTables };
  });

  freed.forEach(emitTable);
  emitTable(target.table);
  emitOrder(target.order);
  ok(res, target.order);
});

export default router;
