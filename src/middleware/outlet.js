import mongoose from 'mongoose';
import { Outlet } from '../modules/outlets/model.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

// Picks the outlet for this request from X-Outlet-Id, or the user's only outlet.
export async function outletScope(req, res, next) {
  if (req.outlet) return next();
  const { restaurantId, role, user } = req;
  let id = req.get('x-outlet-id');

  if (!id) {
    const ids = role.isOwner
      ? (await Outlet.find({ restaurantId }).select('_id').limit(2).lean()).map((o) => String(o._id))
      : user.outletIds.map(String);
    if (ids.length !== 1) throw badRequest('Choose an outlet (X-Outlet-Id header)');
    [id] = ids;
  }

  if (!mongoose.isValidObjectId(id)) throw notFound('Outlet');
  if (!role.isOwner && !user.outletIds.some((o) => String(o) === id)) throw forbidden('No access to this outlet');

  const outlet = await Outlet.findOne({ _id: id, restaurantId });
  if (!outlet) throw notFound('Outlet');

  req.outlet = outlet;
  req.outletId = outlet._id;
  next();
}
