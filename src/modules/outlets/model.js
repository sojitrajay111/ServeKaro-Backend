import mongoose from 'mongoose';
import { makeSchema, ObjectId } from '../../lib/schema.js';

const restaurantSchema = makeSchema({
  name: { type: String, required: true, trim: true },
  legalName: { type: String, default: '' },
  pan: { type: String, default: '' },
  logoUrl: { type: String, default: '' },
  ownerId: { type: ObjectId, ref: 'User' },
}, { tenant: false });

const outletSchema = makeSchema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true },
  city: { type: String, default: '' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  gstin: { type: String, default: '' },
  fssai: { type: String, default: '' },
  timezone: { type: String, default: 'Asia/Kolkata' },
  billPrefix: { type: String, default: 'SK' },
  financialYearStart: { type: String, default: '04-01' },
  pricesIncludeTax: { type: Boolean, default: false },
  roundOff: { type: String, enum: ['nearest_rupee', 'none'], default: 'nearest_rupee' },
  serviceCharge: {
    enabled: { type: Boolean, default: false },
    percent: { type: Number, default: 0 },
    orderTypes: { type: [String], default: ['dine_in'] },
  },
  orderTypes: { type: [String], default: ['dine_in', 'takeaway', 'delivery'] },
  qrOrdering: {
    enabled: { type: Boolean, default: true },
    requireAcceptance: { type: Boolean, default: true },
    allowPayLater: { type: Boolean, default: true },
  },
  bill: {
    header: { type: String, default: '' },
    footer: { type: String, default: 'Thank you! Visit again.' },
    showItemTax: { type: Boolean, default: false },
  },
  theme: {
    primaryColor: { type: String, default: '#FF6B35' },
    accentColor: { type: String, default: '#F7931E' },
    logoUrl: { type: String, default: '' },
  },
  isOpen: { type: Boolean, default: true },
});

export const Restaurant = mongoose.model('Restaurant', restaurantSchema);
export const Outlet = mongoose.model('Outlet', outletSchema);

// Fields the public menu page may see.
export const publicOutlet = (o) => ({
  id: String(o._id),
  name: o.name,
  slug: o.slug,
  address: o.address,
  phone: o.phone,
  theme: o.theme,
  isOpen: o.isOpen,
  pricesIncludeTax: o.pricesIncludeTax,
  qrOrdering: o.qrOrdering,
  orderTypes: o.orderTypes,
});
