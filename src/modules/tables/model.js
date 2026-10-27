import mongoose from 'mongoose';
import { makeSchema, ObjectId } from '../../lib/schema.js';

const areaSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true, index: true },
  name: { type: String, required: true, trim: true },
  sortOrder: { type: Number, default: 0 },
});

const tableSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true, index: true },
  areaId: { type: ObjectId, ref: 'Area' },
  name: { type: String, required: true, trim: true },
  capacity: { type: Number, default: 4 },
  qrToken: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  status: { type: String, enum: ['free', 'occupied', 'billed'], default: 'free' },
  orderId: { type: ObjectId, ref: 'Order', default: null },
  since: Date,
  amount: { type: Number, default: 0 },
  sortOrder: { type: Number, default: 0 },
});
tableSchema.index({ outletId: 1, name: 1 }, { unique: true });

export const Area = mongoose.model('Area', areaSchema);
export const Table = mongoose.model('Table', tableSchema);
