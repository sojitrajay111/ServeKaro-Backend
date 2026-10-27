import mongoose from 'mongoose';
import { makeSchema, subSchema, ObjectId } from '../../lib/schema.js';

const outletRef = { type: ObjectId, ref: 'Outlet', required: true, index: true };

const stationSchema = makeSchema({
  outletId: outletRef,
  name: { type: String, required: true, trim: true },
});

const categorySchema = makeSchema({
  outletId: outletRef,
  name: { type: String, required: true, trim: true },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  // e.g. breakfast menu: { days: [1..7], from: '07:00', to: '11:00' }
  availability: { days: [Number], from: String, to: String },
});

const addonGroupSchema = makeSchema({
  outletId: outletRef,
  name: { type: String, required: true, trim: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  addons: [subSchema({
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    foodType: { type: String, enum: ['veg', 'nonveg', 'egg'], default: 'veg' },
    isActive: { type: Boolean, default: true },
  })],
});

const itemSchema = makeSchema({
  outletId: outletRef,
  categoryId: { type: ObjectId, ref: 'Category', required: true, index: true },
  name: { type: String, required: true, trim: true },
  shortCode: { type: String, default: '' },
  description: { type: String, default: '' },
  foodType: { type: String, enum: ['veg', 'nonveg', 'egg'], default: 'veg' },
  price: { type: Number, required: true, min: 0 },
  variants: [subSchema({
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
  })],
  addonGroupIds: [{ type: ObjectId, ref: 'AddonGroup' }],
  taxGroupId: { type: ObjectId, ref: 'TaxGroup' },
  hsn: { type: String, default: '996331' },
  stationId: { type: ObjectId, ref: 'Station' },
  prepTimeMin: { type: Number, default: 0 },
  tags: { type: [String], enum: ['popular', 'chefSpecial', 'new', 'spicy'], default: [] },
  inStock: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  images: [subSchema({
    url: { type: String, required: true },
    publicId: String,
    isPrimary: { type: Boolean, default: false },
  })],
  orderTypePrices: {
    dine_in: Number,
    takeaway: Number,
    delivery: Number,
  },
  sortOrder: { type: Number, default: 0 },
  deletedAt: Date,
});
itemSchema.index({ outletId: 1, isActive: 1, sortOrder: 1 });

export const Station = mongoose.model('Station', stationSchema);
export const Category = mongoose.model('Category', categorySchema);
export const AddonGroup = mongoose.model('AddonGroup', addonGroupSchema);
export const MenuItem = mongoose.model('MenuItem', itemSchema);
