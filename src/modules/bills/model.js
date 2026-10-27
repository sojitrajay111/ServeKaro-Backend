import mongoose from 'mongoose';
import { makeSchema, subSchema, ObjectId } from '../../lib/schema.js';
import { amountsDef } from '../orders/model.js';

export const PAYMENT_MODES = ['cash', 'card', 'upi', 'wallet', 'online', 'due'];

const paymentSchema = subSchema({
  mode: { type: String, enum: PAYMENT_MODES, required: true },
  amount: { type: Number, required: true, min: 1 },
  reference: { type: String, default: '' },
  refunded: { type: Number, default: 0 },
  shiftId: { type: ObjectId, ref: 'Shift' },
  receivedBy: { type: ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now },
});

const refundSchema = subSchema({
  paymentId: ObjectId,
  mode: String,
  amount: Number,
  reason: String,
  shiftId: { type: ObjectId, ref: 'Shift' },
  by: { type: ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now },
});

const billSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true, index: true },
  billNo: { type: String, required: true },
  seq: { type: Number, required: true },
  financialYear: { type: String, required: true },
  businessDate: { type: String, required: true, index: true },
  orderId: { type: ObjectId, ref: 'Order', required: true, index: true },
  orderNo: Number,
  orderType: String,
  tableName: String,
  lines: [{
    _id: false,
    itemId: ObjectId,
    name: String,
    categoryId: ObjectId,
    categoryName: String,
    qty: Number,
    unitPrice: Number,
    amount: Number,
    hsn: String,
    taxRate: Number,
    taxComponents: [{ _id: false, name: String, rate: Number }],
  }],
  amounts: amountsDef,
  discounts: [{
    _id: false,
    kind: { type: String, enum: ['percent', 'flat'] },
    value: Number,
    amount: Number,
    reason: String,
    appliedBy: ObjectId,
    approvedBy: ObjectId,
  }],
  payments: [paymentSchema],
  refunds: [refundSchema],
  paid: { type: Number, default: 0 },
  due: { type: Number, default: 0 },
  status: { type: String, enum: ['unpaid', 'partly_paid', 'paid', 'void'], default: 'unpaid', index: true },
  isComplimentary: { type: Boolean, default: false },
  customer: { name: String, phone: String, gstin: String },
  voidReason: String,
  voidedBy: ObjectId,
  voidedAt: Date,
  settledAt: Date,
  printCount: { type: Number, default: 0 },
  createdBy: { type: ObjectId, ref: 'User' },
});
billSchema.index({ outletId: 1, financialYear: 1, seq: 1 }, { unique: true });

export const Bill = mongoose.model('Bill', billSchema);
