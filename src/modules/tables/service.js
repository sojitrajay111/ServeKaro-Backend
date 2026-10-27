import { Table } from './model.js';
import { emit, rooms } from '../../lib/events.js';
import { conflict } from '../../lib/errors.js';
import { randomToken } from '../../lib/crypto.js';

export const newQrToken = () => randomToken(16);

const tablePayload = (t) => ({
  id: String(t._id), name: t.name, status: t.status,
  orderId: t.orderId ? String(t.orderId) : null, since: t.since, amount: t.amount,
});

// Atomic: only succeeds if the table is free, so two captains can't both seat it.
export async function occupyTable(restaurantId, tableId, orderId, session) {
  const table = await Table.findOneAndUpdate(
    { _id: tableId, restaurantId, status: 'free', isActive: true },
    { status: 'occupied', orderId, since: new Date(), amount: 0 },
    { new: true, session },
  );
  if (!table) throw conflict('TABLE_OCCUPIED', 'This table already has an open order');
  return table;
}

export const updateTable = (restaurantId, tableId, update, session) =>
  Table.findOneAndUpdate({ _id: tableId, restaurantId }, update, { new: true, session });

export const freeTable = (restaurantId, tableId, session) =>
  updateTable(restaurantId, tableId, { status: 'free', orderId: null, since: null, amount: 0 }, session);

export function emitTable(table) {
  if (table) emit(rooms.outlet(table.outletId), 'table.updated', tablePayload(table));
}
