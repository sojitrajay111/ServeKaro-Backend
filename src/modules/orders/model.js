import mongoose from 'mongoose';
import { makeSchema, subSchema, ObjectId } from '../../lib/schema.js';

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'];

const taxLine = { name: String, rate: Number, taxable: Number, amount: Number };

export const amountsDef = {
  subtotal: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  serviceCharge: { type: Number, default: 0 },
  taxes: [{ _id: false, ...taxLine }],
  roundOff: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
};

// Everything needed to bill and report on an item is copied here, so menu
// edits never change an existing order.
const orderItemSchema = subSchema({
  itemId: { type: ObjectId, ref: 'MenuItem', required: true },
  name: { type: String, required: true },
  variantId: ObjectId,
  variantName: String,
  addons: [{ _id: false, addonId: ObjectId, name: String, price: Number }],
  qty: { type: Number, required: true, min: 0 }, // 0 once fully cancelled (see cancelledQty)
  unitPrice: { type: Number, required: true },
  taxComponents: [{ _id: false, name: String, rate: Number }],
  hsn: String,
  categoryId: ObjectId,
  categoryName: String,
  stationId: ObjectId,
  foodType: String,
  note: { type: String, default: '' },
  kotId: { type: ObjectId, ref: 'Kot', default: null },
  status: { type: String, enum: ['awaiting_acceptance', 'active', 'cancelled'], default: 'active' },
  cancelledQty: { type: Number, default: 0 },
  cancelReason: String,
  addedBy: { type: ObjectId, ref: 'User' },
  addedAt: { type: Date, default: Date.now },
});

const orderSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true, index: true },
  orderNo: { type: Number, required: true },
  businessDate: { type: String, required: true },
  type: { type: String, enum: ORDER_TYPES, required: true },
  source: { type: String, enum: ['pos', 'qr', 'zomato', 'swiggy'], default: 'pos' },
  status: {
    type: String,
    enum: ['awaiting_acceptance', 'open', 'billed', 'settled', 'cancelled'],
    default: 'open',
    index: true,
  },
  tableId: { type: ObjectId, ref: 'Table', default: null },
  tableName: String,
  covers: { type: Number, default: 0 },
  captainId: { type: ObjectId, ref: 'User' },
  customer: { name: String, phone: String },
  note: { type: String, default: '' },
  items: [orderItemSchema],
  amounts: amountsDef,
  billId: { type: ObjectId, ref: 'Bill', default: null },
  trackingToken: { type: String, required: true, unique: true },
  cancelReason: String,
  createdBy: { type: ObjectId, ref: 'User' },
}, { hidden: ['trackingToken'] });
orderSchema.index({ outletId: 1, businessDate: 1, orderNo: 1 }, { unique: true });

const kotSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true, index: true },
  kotNo: { type: Number, required: true },
  businessDate: { type: String, required: true },
  orderId: { type: ObjectId, ref: 'Order', required: true, index: true },
  orderNo: Number,
  orderType: String,
  tableName: String,
  stationId: { type: ObjectId, ref: 'Station', default: null },
  type: { type: String, enum: ['new', 'cancel'], default: 'new' },
  items: [{
    _id: false,
    orderItemId: ObjectId,
    name: String,
    variantName: String,
    addons: [String],
    qty: Number,
    note: String,
  }],
  status: { type: String, enum: ['pending', 'preparing', 'ready', 'served'], default: 'pending', index: true },
  createdBy: { type: ObjectId, ref: 'User' },
  printCount: { type: Number, default: 0 },
});
kotSchema.index({ outletId: 1, businessDate: 1, kotNo: 1 }, { unique: true });

export const Order = mongoose.model('Order', orderSchema);
export const Kot = mongoose.model('Kot', kotSchema);
