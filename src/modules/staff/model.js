import mongoose from 'mongoose';
import { makeSchema, ObjectId } from '../../lib/schema.js';

export const PERMISSIONS = [
  'menu.view', 'menu.edit', 'tables.manage',
  'orders.create', 'orders.cancelItem', 'orders.accept', 'kot.update',
  'bills.create', 'bills.discount', 'bills.void', 'bills.reprint', 'bills.complimentary',
  'payments.collect', 'payments.refund',
  'customers.view', 'customers.edit', 'inventory.view', 'inventory.edit',
  'shift.manage', 'expenses.edit', 'reports.view', 'staff.manage', 'settings.edit',
];

const without = (...keys) => PERMISSIONS.filter((p) => !keys.includes(p));

export const DEFAULT_ROLES = [
  { name: 'Owner', isOwner: true, permissions: PERMISSIONS, maxDiscountPercent: 100 },
  { name: 'Manager', permissions: without('staff.manage', 'settings.edit'), maxDiscountPercent: 50 },
  {
    name: 'Cashier',
    permissions: ['menu.view', 'orders.create', 'orders.cancelItem', 'orders.accept', 'bills.create', 'bills.discount',
      'bills.reprint', 'payments.collect', 'customers.view', 'customers.edit', 'shift.manage'],
    maxDiscountPercent: 10,
  },
  { name: 'Captain', permissions: ['menu.view', 'orders.create', 'orders.accept', 'tables.manage'], maxDiscountPercent: 0 },
  { name: 'Chef', permissions: ['menu.view', 'kot.update'], maxDiscountPercent: 0 },
];

const roleSchema = makeSchema({
  name: { type: String, required: true, trim: true },
  permissions: { type: [String], enum: PERMISSIONS, default: [] },
  maxDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  isOwner: { type: Boolean, default: false },
});
roleSchema.index({ restaurantId: 1, name: 1 }, { unique: true });

const userSchema = makeSchema({
  name: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String },
  passwordHash: { type: String },
  pinHash: { type: String },
  roleId: { type: ObjectId, ref: 'Role', required: true },
  outletIds: [{ type: ObjectId, ref: 'Outlet' }],
  isActive: { type: Boolean, default: true },
  emailVerified: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: Date,
}, { hidden: ['passwordHash', 'pinHash', 'tokenVersion'] });

// Email and phone are global login ids, so unique across all restaurants.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ restaurantId: 1, pinHash: 1 }, { unique: true, partialFilterExpression: { pinHash: { $type: 'string' } } });

export const Role = mongoose.model('Role', roleSchema);
export const User = mongoose.model('User', userSchema);
