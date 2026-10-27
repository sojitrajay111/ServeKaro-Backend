import mongoose from 'mongoose';
import { makeSchema, subSchema } from '../../lib/schema.js';

const taxGroupSchema = makeSchema({
  name: { type: String, required: true, trim: true },
  components: [subSchema({
    name: { type: String, required: true },
    rate: { type: Number, required: true, min: 0, max: 100 },
  })],
});

export const DEFAULT_TAX_GROUPS = [
  { name: 'GST 0%', components: [] },
  { name: 'GST 5%', components: [{ name: 'CGST', rate: 2.5 }, { name: 'SGST', rate: 2.5 }] },
  { name: 'GST 12%', components: [{ name: 'CGST', rate: 6 }, { name: 'SGST', rate: 6 }] },
  { name: 'GST 18%', components: [{ name: 'CGST', rate: 9 }, { name: 'SGST', rate: 9 }] },
];

export const TaxGroup = mongoose.model('TaxGroup', taxGroupSchema);
