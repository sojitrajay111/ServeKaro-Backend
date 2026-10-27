// Dev only: creates a demo restaurant with a menu, tables and staff.
//   npm run seed
import request from 'supertest';
import mongoose from 'mongoose';
import env from '../src/config/env.js';
import app from '../src/app.js';
import { connectDb } from '../src/lib/db.js';

if (env.isProd) {
  console.error('Refusing to seed in production');
  process.exit(1);
}

await connectDb(env.mongoUri);
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));

const api = request(app);
const V = '/api/v1';
const login = { email: 'demo@servekaro.com', password: 'demo-pass-123' };

let res = await api.post(`${V}/auth/signup`).send({
  restaurantName: 'Spice Route',
  outletName: 'Spice Route',
  city: 'Ahmedabad',
  ownerName: 'Demo Owner',
  email: login.email,
  phone: '9000000001',
  password: login.password,
});
if (res.status === 409) {
  console.log(`Already seeded. Log in with ${login.email} / ${login.password}`);
  process.exit(0);
}
if (res.status !== 201) throw new Error(JSON.stringify(res.body));

const { accessToken, outlets } = res.body.data;
const outletId = outlets[0].id;
const call = (method, url, body) => api[method](V + url)
  .set('Authorization', `Bearer ${accessToken}`)
  .set('X-Outlet-Id', outletId)
  .send(body)
  .then((r) => {
    if (r.status >= 400) throw new Error(`${method} ${url}: ${JSON.stringify(r.body)}`);
    return r.body.data;
  });

const taxes = await call('get', '/tax-groups');
const gst5 = taxes.find((t) => t.name === 'GST 5%').id;
const tandoor = (await call('post', '/stations', { name: 'Tandoor' })).id;
const kitchen = (await call('post', '/stations', { name: 'Main Kitchen' })).id;
const bar = (await call('post', '/stations', { name: 'Bar' })).id;

const extras = (await call('post', '/addon-groups', {
  name: 'Extras', min: 0, max: 3,
  addons: [{ name: 'Extra cheese', price: 3000 }, { name: 'Extra butter', price: 2000 }, { name: 'Extra gravy', price: 4000 }],
})).id;
const spice = (await call('post', '/addon-groups', {
  name: 'Spice level', min: 1, max: 1,
  addons: [{ name: 'Mild', price: 0 }, { name: 'Medium', price: 0 }, { name: 'Hot', price: 0 }],
})).id;

const menu = {
  Starters: [
    { name: 'Paneer Tikka', price: 24900, foodType: 'veg', stationId: tandoor, variants: [{ name: 'Half', price: 14900 }, { name: 'Full', price: 24900 }], addonGroupIds: [extras], tags: ['popular'] },
    { name: 'Chicken Tikka', price: 29900, foodType: 'nonveg', stationId: tandoor, variants: [{ name: 'Half', price: 17900 }, { name: 'Full', price: 29900 }], tags: ['chefSpecial'] },
    { name: 'Hara Bhara Kabab', price: 19900, foodType: 'veg', stationId: tandoor },
  ],
  'Main Course': [
    { name: 'Paneer Butter Masala', price: 27900, foodType: 'veg', stationId: kitchen, addonGroupIds: [spice, extras], tags: ['popular'] },
    { name: 'Dal Makhani', price: 21900, foodType: 'veg', stationId: kitchen, addonGroupIds: [spice] },
    { name: 'Butter Chicken', price: 32900, foodType: 'nonveg', stationId: kitchen, addonGroupIds: [spice], tags: ['popular'] },
    { name: 'Egg Curry', price: 19900, foodType: 'egg', stationId: kitchen, addonGroupIds: [spice] },
  ],
  Breads: [
    { name: 'Butter Naan', price: 6000, foodType: 'veg', stationId: tandoor },
    { name: 'Garlic Naan', price: 7000, foodType: 'veg', stationId: tandoor, tags: ['new'] },
    { name: 'Tandoori Roti', price: 3000, foodType: 'veg', stationId: tandoor },
  ],
  Beverages: [
    { name: 'Masala Chaas', price: 6900, foodType: 'veg', stationId: bar },
    { name: 'Sweet Lassi', price: 8900, foodType: 'veg', stationId: bar },
    { name: 'Fresh Lime Soda', price: 7900, foodType: 'veg', stationId: bar },
  ],
};

let sort = 0;
for (const [category, items] of Object.entries(menu)) {
  const cat = await call('post', '/categories', { name: category, sortOrder: sort++ });
  for (const item of items) await call('post', '/items', { ...item, categoryId: cat.id, taxGroupId: gst5 });
}

const indoor = (await call('post', '/areas', { name: 'Indoor' })).id;
const terrace = (await call('post', '/areas', { name: 'Terrace' })).id;
for (let i = 1; i <= 8; i++) await call('post', '/tables', { name: `T${i}`, areaId: indoor, capacity: 4 });
for (let i = 1; i <= 4; i++) await call('post', '/tables', { name: `R${i}`, areaId: terrace, capacity: 6 });

const { roles } = await call('get', '/roles');
const roleId = (name) => roles.find((r) => r.name === name).id;
const people = [
  ['Meera (Manager)', 'Manager', '9000000002', '1111'],
  ['Arjun (Cashier)', 'Cashier', '9000000003', '2222'],
  ['Ravi (Captain)', 'Captain', '9000000004', '3333'],
  ['Sanjay (Chef)', 'Chef', '9000000005', '4444'],
];
for (const [name, role, phone, pin] of people) {
  await call('post', '/staff', { name, phone, roleId: roleId(role), outletIds: [outletId], pin });
}
await call('patch', `/outlets/${outletId}`, { gstin: '24AAACS1234A1Z5' });
await call('post', '/shifts/open', { openingCash: 200000 });

console.log(`
Seeded "Spice Route".
  Owner login : ${login.email} / ${login.password}
  Staff PINs  : Manager 1111, Cashier 2222, Captain 3333, Chef 4444
                (PIN login needs a registered device: POST /api/v1/auth/devices)
  Outlet id   : ${outletId}
`);
await mongoose.disconnect();
