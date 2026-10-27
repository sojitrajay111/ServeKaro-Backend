import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import app from '../src/app.js';
import { attachSocket } from '../src/socket.js';
import { api, V, as, signup, seedMenu, syncIndexes } from './helpers.js';

let server;
let url;
let owner;
let menu;
const sockets = [];

const open = (opts = {}) => new Promise((resolve, reject) => {
  const s = connect(url, { path: '/realtime', transports: ['websocket'], ...opts });
  sockets.push(s);
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const next = (s, event) => new Promise((resolve) => s.once(event, resolve));

beforeAll(async () => {
  await syncIndexes();
  server = http.createServer(app);
  attachSocket(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
  owner = await signup();
  menu = await seedMenu(as(owner.token, owner.outletId));
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => server.close(r));
});

describe('realtime', () => {
  it('rejects a bad token', async () => {
    await expect(open({ auth: { token: 'nope' } })).rejects.toThrow('UNAUTHENTICATED');
  });

  it('staff get new orders; customers only get their own order', async () => {
    const staffSock = await open({ auth: { token: owner.token } });
    const created = next(staffSock, 'order.created');
    const qrToken = menu.table.qrUrl.split('/t/')[1];

    const res = await api.post(`${V}/public/orders`).send({
      qrToken, customer: { name: 'Asha', phone: '9876543210' }, items: [{ itemId: menu.naan.id, qty: 1 }],
    });
    const order = await created;
    expect(order.id).toBe(res.body.data.orderId);
    expect(order.status).toBe('awaiting_acceptance');

    const customer = await open();
    const joined = await customer.emitWithAck('join:order', { trackingToken: res.body.data.trackingToken });
    expect(joined.ok).toBe(true);

    const stranger = await open();
    let strangerGotIt = false;
    stranger.on('kot.updated', () => { strangerGotIt = true; });

    const c = as(owner.token, owner.outletId);
    await c.post(`/orders/${order.id}/accept`);
    const kot = (await c.get('/kots')).body.data[0];
    const update = next(customer, 'kot.updated');
    await c.patch(`/kots/${kot.id}`, { status: 'preparing' });
    expect(await update).toMatchObject({ orderId: order.id, status: 'preparing' });
    expect(strangerGotIt).toBe(false);
  });

  it('customers cannot join staff rooms', async () => {
    const customer = await open();
    const res = await customer.emitWithAck('join:station', { stationId: menu.station.id });
    expect(res.ok).toBe(false);
  });
});
