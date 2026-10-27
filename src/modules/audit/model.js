import mongoose from 'mongoose';
import { makeSchema, ObjectId } from '../../lib/schema.js';

const auditSchema = makeSchema({
  outletId: { type: ObjectId, ref: 'Outlet' },
  userId: { type: ObjectId, ref: 'User' },
  userName: String,
  approvedBy: { type: ObjectId, ref: 'User' },
  action: { type: String, required: true, index: true },
  entity: String,
  entityId: ObjectId,
  details: mongoose.Schema.Types.Mixed,
  ip: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
auditSchema.index({ restaurantId: 1, createdAt: -1 });

// Append-only.
for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne']) {
  auditSchema.pre(hook, () => { throw new Error('Audit log is append-only'); });
}

export const AuditLog = mongoose.model('AuditLog', auditSchema);
