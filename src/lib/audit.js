import { AuditLog } from '../modules/audit/model.js';

/**
 * audit(req, 'bill.void', { entity: 'Bill', entityId, details, approvedBy }, session)
 */
export async function audit(req, action, { entity, entityId, details, approvedBy } = {}, session) {
  await AuditLog.create([{
    restaurantId: req.restaurantId,
    outletId: req.outlet?._id,
    userId: req.user?._id,
    userName: req.user?.name,
    approvedBy,
    action,
    entity,
    entityId,
    details,
    ip: req.ip,
  }], { session });
}
