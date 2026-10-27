import mongoose from 'mongoose';
import { makeSchema, ObjectId } from '../../lib/schema.js';

// One row per refresh token. Rotating a token revokes the old row and creates a
// new one in the same family; presenting a revoked token kills the family.
const sessionSchema = makeSchema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  family: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  userAgent: String,
  ip: String,
}, { tenant: false });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const otpSchema = makeSchema({
  login: { type: String, required: true, index: true },
  purpose: { type: String, enum: ['reset_password'], required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  usedAt: Date,
  expiresAt: { type: Date, required: true },
}, { tenant: false });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const deviceSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet', required: true },
  name: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  failedPins: { type: Number, default: 0 },
  lockedUntil: Date,
  createdBy: { type: ObjectId, ref: 'User' },
  lastUsedAt: Date,
}, { hidden: ['tokenHash'] });

export const Session = mongoose.model('Session', sessionSchema);
export const Otp = mongoose.model('Otp', otpSchema);
export const Device = mongoose.model('Device', deviceSchema);
