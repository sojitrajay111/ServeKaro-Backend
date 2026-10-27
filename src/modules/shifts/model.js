import mongoose from 'mongoose';
import { makeSchema, subSchema, ObjectId } from '../../lib/schema.js';

const shiftSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  businessDate: { type: String, required: true },
  openedBy: { type: ObjectId, ref: 'User', required: true },
  openedAt: { type: Date, default: Date.now },
  openingCash: { type: Number, required: true, min: 0 },
  cashMovements: [subSchema({
    kind: { type: String, enum: ['in', 'out'], required: true },
    amount: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },
    by: { type: ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  })],
  closedBy: { type: ObjectId, ref: 'User' },
  closedAt: Date,
  expectedCash: Number,
  countedCash: Number,
  difference: Number,
  denominations: { type: Map, of: Number },
  note: String,
});
// Only one open shift per outlet.
shiftSchema.index({ outletId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
shiftSchema.index({ outletId: 1, openedAt: -1 });

export const Shift = mongoose.model('Shift', shiftSchema);
