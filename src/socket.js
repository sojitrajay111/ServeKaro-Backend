import { Server } from 'socket.io';
import mongoose from 'mongoose';
import env from './config/env.js';
import { verifyAccessToken, loadPrincipal } from './middleware/auth.js';
import { setIo, rooms } from './lib/events.js';
import { Outlet } from './modules/outlets/model.js';
import { Station } from './modules/menu/model.js';
import { Order } from './modules/orders/model.js';

const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);
const isToken = (v) => typeof v === 'string' && /^[\w-]{16,64}$/.test(v);

export function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    path: '/realtime',
    cors: { origin: env.corsOrigins, credentials: true },
    maxHttpBufferSize: 1e4, // clients only send tiny join messages
  });

  // Staff send { auth: { token } }. Customers connect without a token and can
  // only join their own order's room.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next();
    try {
      const { user, role } = await loadPrincipal(verifyAccessToken(token));
      socket.data.user = user;
      socket.data.role = role;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', async (socket) => {
    const { user, role } = socket.data;
    let outletIds = [];

    if (user) {
      outletIds = role.isOwner
        ? (await Outlet.find({ restaurantId: user.restaurantId }).select('_id').lean()).map((o) => String(o._id))
        : user.outletIds.map(String);
      socket.join(outletIds.map(rooms.outlet));
    }

    // Kitchen screens: only get KOTs for their station.
    socket.on('join:station', async ({ stationId } = {}, ack) => {
      if (!user || !isId(stationId)) return ack?.({ ok: false });
      const station = await Station.findOne({ _id: stationId, restaurantId: user.restaurantId }).lean();
      const allowed = station && outletIds.includes(String(station.outletId));
      if (allowed) socket.join(rooms.station(stationId));
      ack?.({ ok: Boolean(allowed) });
    });

    socket.on('join:order', async ({ trackingToken } = {}, ack) => {
      if (!isToken(trackingToken)) return ack?.({ ok: false });
      const order = await Order.findOne({ trackingToken }).setOptions({ crossTenant: true }).select('_id').lean();
      if (order) socket.join(rooms.order(order._id));
      ack?.({ ok: Boolean(order) });
    });

    // Live sold-out updates on the customer menu.
    socket.on('join:menu', async ({ slug } = {}, ack) => {
      if (typeof slug !== 'string' || !/^[a-z0-9-]{3,50}$/.test(slug)) return ack?.({ ok: false });
      const outlet = await Outlet.findOne({ slug }).setOptions({ crossTenant: true }).select('_id').lean();
      if (outlet) socket.join(rooms.menu(outlet._id));
      ack?.({ ok: Boolean(outlet) });
    });
  });

  setIo(io);
  return io;
}
