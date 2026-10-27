import { describe, it, expect, beforeAll } from 'vitest';
import { api, V, as, signup, staff, seedMenu, syncIndexes } from './helpers.js';

let owner;
let c;
let menu;

beforeAll(async () => {
  await syncIndexes();
  owner = await signup();
  c = as(owner.token, owner.outletId);
  menu = await seedMenu(c);
});

const tikkaFull = () => ({
  itemId: menu.tikka.id,
  variantId: menu.tikka.variants.find((v) => v.name === 'Full').id,
  addonIds: [menu.addons.addons.find((a) => a.name === 'Cheese').id],
  qty: 2,
});
const naan = (qty = 4) => ({ itemId: menu.naan.id, qty });

describe('signup and session', () => {
  it('creates owner with all permissions, default roles and GST groups', async () => {
    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.role.isOwner).toBe(true);
    expect(me.body.data.user.passwordHash).toBeUndefined();
    expect((await c.get('/roles')).body.data.roles.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Owner', 'Manager', 'Cashier', 'Captain', 'Chef']),
    );
    expect(menu.gst5.components).toHaveLength(2);
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await api.post(`${V}/auth/login`).send({ login: 'nobody@test.com', password: 'whatever-123' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_LOGIN');
  });

  it('rotates refresh tokens and kills the family on reuse', async () => {
    const cookie = owner.cookie;
    const first = await api.post(`${V}/auth/refresh`).set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toBeTruthy();
    const newCookie = first.headers['set-cookie'];

    const reuse = await api.post(`${V}/auth/refresh`).set('Cookie', cookie);
    expect(reuse.status).toBe(401);
    // The rotated token is now dead too, because its family was revoked.
    expect((await api.post(`${V}/auth/refresh`).set('Cookie', newCookie)).status).toBe(401);
  });

  it('rejects unknown fields (no mass assignment / operator injection)', async () => {
    const res = await c.post('/categories', { name: 'X', restaurantId: '000000000000000000000000' });
    expect(res.status).toBe(400);
    const res2 = await api.post(`${V}/auth/login`).send({ login: { $ne: null }, password: 'x' });
    expect(res2.status).toBe(400);
  });
});

describe('menu', () => {
  it('returns the full menu in one call with an ETag', async () => {
    const res = await c.get('/menu');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.headers.etag).toBeTruthy();
    const again = await c.get('/menu').set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
  });

  it('needs a variant for items that have them', async () => {
    const res = await c.post('/orders', { type: 'takeaway', items: [{ itemId: menu.tikka.id, qty: 1 }] });
    expect(res.status).toBe(400);
  });

  it('enforces add-on group max', async () => {
    const t = tikkaFull();
    const res = await c.post('/orders', {
      type: 'takeaway',
      items: [{ ...t, addonIds: [...menu.addons.addons.map((a) => a.id), menu.addons.addons[0].id] }],
    });
    // 2 add-ons allowed, but the duplicated id makes the count mismatch.
    expect(res.status).toBe(400);
  });
});

describe('dine-in: order → KOT → bill → split payment → settled', () => {
  let order;
  let bill;

  it('needs an open shift before payments, so open one', async () => {
    const res = await c.post('/shifts/open', { openingCash: 200000 });
    expect(res.status).toBe(201);
    expect((await c.post('/shifts/open', { openingCash: 0 })).body.code).toBe('SHIFT_ALREADY_OPEN');
  });

  it('creates order, sends KOT to the station, occupies the table', async () => {
    const res = await c.post('/orders', { type: 'dine_in', tableId: menu.table.id, covers: 2, items: [tikkaFull(), naan()] });
    expect(res.status).toBe(201);
    order = res.body.data;
    expect(order.orderNo).toBe(1);
    expect(order.amounts.subtotal).toBe(79800); // (24900+3000)*2 + 6000*4
    expect(order.amounts.total).toBe(83800);
    expect(order.items.every((i) => i.kotId)).toBe(true);
    expect(order.trackingToken).toBeUndefined();

    const kots = (await c.get('/kots')).body.data;
    expect(kots).toHaveLength(2); // Tandoor + no-station
    expect(kots.find((k) => k.stationId === menu.station.id).items[0].name).toBe('Paneer Tikka');

    const table = (await c.get(`/tables/${menu.table.id}`)).body.data;
    expect(table.status).toBe('occupied');
    expect(table.amount).toBe(83800);
  });

  it('refuses a second order on an occupied table', async () => {
    const res = await c.post('/orders', { type: 'dine_in', tableId: menu.table.id, items: [naan(1)] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TABLE_OCCUPIED');
  });

  it('cancelling a sent item makes a cancel KOT and an audit entry', async () => {
    const added = await c.post(`/orders/${order.id}/items`, { items: [naan(2)] });
    const extra = added.body.data.items.at(-1);
    const res = await c.post(`/orders/${order.id}/items/${extra.id}/cancel`, { qty: 2, reason: 'Customer changed mind' });
    expect(res.status).toBe(200);
    expect(res.body.data.amounts.total).toBe(83800);
    const kots = (await c.get('/kots')).body.data;
    expect(kots.some((k) => k.type === 'cancel')).toBe(true);
    const logs = (await c.get('/audit-logs?action=order.item_cancel')).body.data;
    expect(logs).toHaveLength(1);
  });

  it('kitchen moves KOT forward only', async () => {
    const kot = (await c.get('/kots')).body.data[0];
    expect((await c.patch(`/kots/${kot.id}`, { status: 'ready' })).status).toBe(200);
    expect((await c.patch(`/kots/${kot.id}`, { status: 'preparing' })).status).toBe(409);
  });

  it('bills with a 10% discount: GST after discount, rounded, numbered', async () => {
    const res = await c.post('/bills', { orderId: order.id, discount: { kind: 'percent', value: 10, reason: 'Regular' } });
    expect(res.status).toBe(201);
    bill = res.body.data;
    expect(bill.billNo).toMatch(/^SK\/\d{2}-\d{2}\/000001$/);
    expect(bill.amounts.discount).toBe(7980);
    expect(bill.amounts.taxes.map((t) => t.amount)).toEqual([1796, 1796]);
    expect(bill.amounts.total).toBe(75400);
    expect(bill.amounts.roundOff).toBe(-12);
    expect((await c.get(`/tables/${menu.table.id}`)).body.data.status).toBe('billed');
  });

  it('refuses adding items to a billed order', async () => {
    expect((await c.post(`/orders/${order.id}/items`, { items: [naan(1)] })).status).toBe(409);
  });

  it('takes a split payment and settles', async () => {
    const r1 = await c.post(`/bills/${bill.id}/payments`, { mode: 'cash', amount: 40000 });
    expect(r1.body.data.status).toBe('partly_paid');
    expect((await c.post(`/bills/${bill.id}/payments`, { mode: 'upi', amount: 99999 })).status).toBe(400);
    const r2 = await c.post(`/bills/${bill.id}/payments`, { mode: 'upi', amount: 35400, reference: 'UPI123' });
    expect(r2.body.data.status).toBe('paid');
    expect((await c.get(`/orders/${order.id}`)).body.data.status).toBe('settled');
    expect((await c.get(`/tables/${menu.table.id}`)).body.data.status).toBe('free');
  });

  it('reports and day end match the bill', async () => {
    const today = bill.businessDate;
    const sales = (await c.get(`/reports/sales?from=${today}&to=${today}`)).body.data;
    expect(sales[0]).toMatchObject({ bills: 1, gross: 79800, discount: 7980, net: 75400 });

    const tax = (await c.get(`/reports/tax?from=${today}&to=${today}`)).body.data;
    expect(tax.byRate.reduce((s, t) => s + t.amount, 0)).toBe(3592);

    const shift = (await c.get('/shifts/current')).body.data;
    expect(shift.cash.expected).toBe(240000); // 2000 opening + 400 cash

    const csv = await c.get(`/reports/items?from=${today}&to=${today}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Paneer Tikka (Full)');

    const dash = (await c.get('/reports/dashboard')).body.data;
    expect(dash.sales).toBe(75400);
  });

  it('void needs refunds first, then works and keeps the number', async () => {
    const blocked = await c.post(`/bills/${bill.id}/void`, { reason: 'Wrong table' });
    expect(blocked.body.code).toBe('PAYMENTS_EXIST');

    const full = (await c.get(`/bills/${bill.id}`)).body.data;
    for (const p of full.payments) {
      expect((await c.post(`/bills/${bill.id}/payments/${p.id}/refund`, { amount: p.amount, reason: 'Wrong table' })).status).toBe(200);
    }
    const res = await c.post(`/bills/${bill.id}/void`, { reason: 'Wrong table' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('void');
    expect(res.body.data.billNo).toBe(bill.billNo);

    const shift = (await c.get('/shifts/current')).body.data;
    expect(shift.cash.expected).toBe(200000);
  });

  it('closes the shift with the difference recorded', async () => {
    const res = await c.post('/shifts/current/close', { countedCash: 199000 });
    expect(res.body.data.difference).toBe(-1000);
    expect((await c.post(`/bills/${bill.id}/payments`, { mode: 'cash', amount: 100 })).body.code).toBe('NO_OPEN_SHIFT');
  });
});

describe('permissions and approval', () => {
  let cashier;
  let captain;
  let order;

  beforeAll(async () => {
    await staff(owner, 'Manager', '4321');
    cashier = await staff(owner, 'Cashier');
    captain = await staff(owner, 'Captain');
    await c.post('/shifts/open', { openingCash: 0 });
  });

  it('captain can take orders but not bill', async () => {
    const cap = as(captain.token, captain.outletId);
    const res = await cap.post('/orders', { type: 'takeaway', items: [naan(2)] });
    expect(res.status).toBe(201);
    order = res.body.data;
    expect((await cap.post('/bills', { orderId: order.id })).status).toBe(403);
    expect((await cap.get('/reports/dashboard')).status).toBe(403);
    expect((await cap.get('/staff')).status).toBe(403);
  });

  it('cashier discount above their limit needs a manager PIN', async () => {
    const cash = as(cashier.token, cashier.outletId);
    const discount = { kind: 'percent', value: 30, reason: 'Friend' };
    const noPin = await cash.post('/bills', { orderId: order.id, discount });
    expect(noPin.body.code).toBe('APPROVAL_REQUIRED');
    const badPin = await cash.post('/bills', { orderId: order.id, discount, approval: { pin: '0000' } });
    expect(badPin.body.code).toBe('APPROVAL_INVALID');
    const okRes = await cash.post('/bills', { orderId: order.id, discount, approval: { pin: '4321' } });
    expect(okRes.status).toBe(201);
    expect(okRes.body.data.discounts[0].approvedBy).toBeTruthy();
  });

  it('cashier cannot void without approval', async () => {
    const cash = as(cashier.token, cashier.outletId);
    const bills = (await c.get('/bills')).body.data;
    const res = await cash.post(`/bills/${bills[0].id}/void`, { reason: 'Test void' });
    expect(res.body.code).toBe('APPROVAL_REQUIRED');
  });

  it('disabling a user logs them out immediately', async () => {
    await c.patch(`/staff/${captain.user.id}`, { isActive: false });
    expect((await as(captain.token, captain.outletId).get('/menu')).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it("restaurant B can't see or touch restaurant A's data", async () => {
    const other = await signup();
    const o = as(other.token, other.outletId);
    const orderId = (await c.get('/orders')).body.data[0].id;
    const billId = (await c.get('/bills')).body.data[0].id;

    expect((await o.get(`/orders/${orderId}`)).status).toBe(404);
    expect((await o.get(`/bills/${billId}`)).status).toBe(404);
    expect((await o.get(`/tables/${menu.table.id}`)).status).toBe(404);
    expect((await o.patch(`/items/${menu.naan.id}`, { price: 1 })).status).toBe(404);
    expect((await o.post('/orders', { type: 'takeaway', items: [naan(1)] })).status).toBe(400);
    // A's outlet id with B's token: 404, not 403, so ids of other restaurants don't leak.
    expect((await as(other.token, owner.outletId).get('/orders')).status).toBe(404);
  });
});

describe('idempotency', () => {
  it('same Idempotency-Key creates one order', async () => {
    const send = () => api.post(`${V}/orders`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Outlet-Id', owner.outletId)
      .set('Idempotency-Key', 'abc-123')
      .send({ type: 'takeaway', items: [naan(1)] });
    const a = await send();
    const b = await send();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
  });
});

describe('bill numbers', () => {
  it('stay gapless under concurrent billing', async () => {
    const N = 15;
    const orders = [];
    for (let i = 0; i < N; i += 1) {
      orders.push((await c.post('/orders', { type: 'takeaway', items: [naan(1)] })).body.data);
    }
    const results = await Promise.all(orders.map((o) => c.post('/bills', { orderId: o.id })));
    expect(results.every((r) => r.status === 201)).toBe(true);

    const all = [];
    for (let page = 1; ; page += 1) {
      const res = (await c.get(`/bills?limit=200&page=${page}`)).body;
      all.push(...res.data);
      if (all.length >= res.meta.total) break;
    }
    const seqs = all.map((b) => Number(b.billNo.split('/').pop())).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });
});

describe('customer QR ordering', () => {
  let table;
  let tracking;

  beforeAll(async () => {
    table = (await c.get(`/tables/${menu.table2.id}`)).body.data;
  });

  const qrToken = () => table.qrUrl.split('/t/')[1];

  it('loads the menu from the QR without internal fields', async () => {
    const res = await api.get(`${V}/public/t/${qrToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.table.name).toBe('T2');
    expect(res.body.data.menu.items[0].hsn).toBeUndefined();
    expect(res.body.data.outlet.gstin).toBeUndefined();
  });

  it('cannot send prices', async () => {
    const res = await api.post(`${V}/public/orders`).send({
      qrToken: qrToken(), customer: { name: 'Asha', phone: '9876543210' },
      items: [{ ...naan(1), unitPrice: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('places an order that waits for staff, then staff accept it', async () => {
    const res = await api.post(`${V}/public/orders`).send({
      qrToken: qrToken(), customer: { name: 'Asha', phone: '98765 43210' }, items: [naan(2)],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('awaiting_acceptance');
    tracking = res.body.data.trackingToken;

    // A friend at the same table adds to the same order.
    const friend = await api.post(`${V}/public/orders`).send({
      qrToken: qrToken(), customer: { name: 'Ravi', phone: '9876500000' }, items: [naan(1)],
    });
    expect(friend.body.data.orderId).toBe(res.body.data.orderId);

    const billFirst = await c.post('/bills', { orderId: res.body.data.orderId });
    expect(billFirst.body.code).toBe('ORDER_NOT_OPEN');

    const accepted = await c.post(`/orders/${res.body.data.orderId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.status).toBe('open');
    expect(accepted.body.data.items.every((i) => i.kotId)).toBe(true);
  });

  it('customer can track the order', async () => {
    const res = await api.get(`${V}/public/orders/${tracking}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].kitchenStatus).toBe('pending');
    expect(res.body.data.items[0].unitPrice).toBeUndefined();
  });

  it('a rotated QR stops working', async () => {
    const old = qrToken();
    await c.post(`/tables/${menu.table2.id}/qr/rotate`);
    expect((await api.get(`${V}/public/t/${old}`)).status).toBe(404);
  });
});
