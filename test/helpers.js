import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { User } from '../src/modules/staff/model.js';

export const api = request(app);
export const V = '/api/v1';

// Unique indexes (one open shift, gapless bill seq...) must exist before tests run.
export async function syncIndexes() {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));
}

let n = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++n}`.padStart(8, '0').slice(-8);

export async function signup(extra = {}) {
  const id = uniq();
  const res = await api.post(`${V}/auth/signup`).send({
    restaurantName: `Cafe ${id}`,
    outletName: 'Main',
    city: 'Ahmedabad',
    ownerName: 'Owner Person',
    email: `owner${id}@test.com`,
    phone: `98${id}`,
    password: 'password-123',
    ...extra,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const { accessToken, outlets, user } = res.body.data;
  return { token: accessToken, outletId: outlets[0].id, user, cookie: res.headers['set-cookie'] };
}

export const as = (token, outletId) => ({
  get: (url) => api.get(V + url).set('Authorization', `Bearer ${token}`).set('X-Outlet-Id', outletId || ''),
  post: (url, body) => api.post(V + url).set('Authorization', `Bearer ${token}`).set('X-Outlet-Id', outletId || '').send(body),
  patch: (url, body) => api.patch(V + url).set('Authorization', `Bearer ${token}`).set('X-Outlet-Id', outletId || '').send(body),
  put: (url, body) => api.put(V + url).set('Authorization', `Bearer ${token}`).set('X-Outlet-Id', outletId || '').send(body),
  delete: (url) => api.delete(V + url).set('Authorization', `Bearer ${token}`).set('X-Outlet-Id', outletId || ''),
});

// Creates a staff member with a role, sets a password directly (skipping the
// email invite) and logs in.
export async function staff(owner, roleName, pin) {
  const roles = (await as(owner.token, owner.outletId).get('/roles')).body.data.roles;
  const role = roles.find((r) => r.name === roleName);
  const id = uniq();
  const res = await as(owner.token, owner.outletId).post('/staff', {
    name: `${roleName} ${id}`,
    phone: `97${id}`,
    email: `${roleName.toLowerCase()}${id}@test.com`,
    roleId: role.id,
    outletIds: [owner.outletId],
    ...(pin && { pin }),
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  await User.updateOne({ _id: res.body.data.id }, { passwordHash: await bcrypt.hash('password-123', 4) })
    .setOptions({ crossTenant: true });
  const login = await api.post(`${V}/auth/login`).send({ login: `97${id}`, password: 'password-123' });
  return { token: login.body.data.accessToken, outletId: owner.outletId, user: login.body.data.user };
}

// A small menu: 5% GST, one plain item, one item with variants + an add-on group.
export async function seedMenu(c) {
  const taxGroups = (await c.get('/tax-groups')).body.data;
  const gst5 = taxGroups.find((t) => t.name === 'GST 5%');
  const station = (await c.post('/stations', { name: 'Tandoor' })).body.data;
  const cat = (await c.post('/categories', { name: 'Starters' })).body.data;
  const addons = (await c.post('/addon-groups', {
    name: 'Extras', min: 0, max: 2, addons: [{ name: 'Cheese', price: 3000 }, { name: 'Butter', price: 2000 }],
  })).body.data;
  const tikka = (await c.post('/items', {
    categoryId: cat.id, name: 'Paneer Tikka', foodType: 'veg', price: 24900,
    variants: [{ name: 'Half', price: 14900 }, { name: 'Full', price: 24900 }],
    addonGroupIds: [addons.id], taxGroupId: gst5.id, stationId: station.id,
  })).body.data;
  const naan = (await c.post('/items', {
    categoryId: cat.id, name: 'Butter Naan', foodType: 'veg', price: 6000, taxGroupId: gst5.id,
  })).body.data;
  const table = (await c.post('/tables', { name: 'T1' })).body.data;
  const table2 = (await c.post('/tables', { name: 'T2' })).body.data;
  return { gst5, station, cat, addons, tikka, naan, table, table2 };
}
