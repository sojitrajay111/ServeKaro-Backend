# ServeKaro Backend

Restaurant POS + QR ordering API: KOTs, GST billing, split payments, shifts, reports. One deployment serves many restaurants.

Stack: Node 22+, Express 5, MongoDB (Mongoose 8), Socket.IO, JWT, Zod. Every endpoint is in [API.md](API.md).

## Run it

```bash
npm install
cp .env.example .env      # fill in MONGO_URI and the two JWT secrets
npm run seed              # demo restaurant: demo@servekaro.com / demo-pass-123
npm run dev               # http://localhost:5000, API under /api/v1
npm test                  # needs no setup, starts its own MongoDB
```

MongoDB has to be a replica set (billing uses transactions). Atlas is one. Locally:
`mongod --replSet rs0` once, then `mongosh --eval "rs.initiate()"`.

Without `CLOUDINARY_URL` image upload returns 503. Without `SMTP_URL` emails (OTP, invites) are printed to the console in dev.

## Layout

```
src/
  server.js              http server, socket, shutdown
  app.js                 middleware and route mounting
  socket.js              realtime rooms (outlet, station, order, menu)
  config/env.js          reads .env, exits if something required is missing
  lib/                   money (all billing maths), counters, dates, audit, approval, events, schema helpers
  middleware/            auth + can(permission), outletScope, validate (zod), idempotency, rate limits, upload, errors
  modules/<name>/        model.js, routes.js, service.js when routes share logic
    auth staff outlets taxes menu tables orders bills shifts reports audit public
test/                    money unit tests, full POS flow, realtime
scripts/seed.js          demo data
```

Routers share the `/api/v1` mount, so each one scopes its middleware to its own paths
(`router.use(['/orders', '/kots'], authenticate, outletScope)`). Never use a bare `router.use(...)`:
it would run for every other router's requests too.

## Phases

1. **POS core** (built): auth, staff/roles, outlet settings, taxes, menu with variants/add-ons/stations, areas/tables, orders + KOT, bills + split payments, refunds, void, NC, shifts + day end, core reports, audit log, QR ordering, realtime.
2. **Operations**: customers + credit ledger, discounts/coupons, inventory + recipes, expenses, remaining reports, PDF/WhatsApp bills, split bills, print agent, menu CSV import.
3. **Growth**: multi-outlet UI, loyalty, pay-at-table, Zomato/Swiggy via an integrator.

## Data rules

**Tenancy.** Every tenant document has `restaurantId`. `makeSchema()` adds a guard that throws on any query or aggregate without it. The few cross-tenant lookups (login, QR token, tracking token) opt out with `.setOptions({ crossTenant: true })`; grep for that when reviewing.

**Money** is integer paise in the DB and the API. Only `lib/money.js` adds money up. For exclusive tax the total is built from the rounded figures on the bill, so subtotal − discount + service charge + taxes + round-off always equals the total.

**Snapshots.** Order items copy name, price, add-ons, tax components, HSN and category when added. Bills copy lines from the order. Menu edits never change history; items are soft-deleted.

**Numbers.** `orderNo` and `kotNo` restart daily per outlet. `billNo` is `<prefix>/<FY>/<000001>`, per outlet per financial year, gapless: the counter is incremented inside the bill's transaction, so an aborted bill rolls its number back.

**Transactions** wrap every multi-document change (order + table + KOT, bill + order + table, payment + settle, void, transfer, merge). Socket events are emitted after commit, never inside.

**Bills** are never edited once paid. To undo a paid bill: refund the payments, then void it (the number is kept).

## Security

- `helmet`, CORS allowlist, 100 kb JSON limit, `trust proxy` 1.
- Passwords: bcrypt cost 12, min 8 chars. Login compares against a dummy hash when the user doesn't exist, so timing doesn't reveal accounts.
- PINs and OTPs: HMAC-SHA256 keyed with the server secret. A DB dump alone can't brute-force them. Wrong PINs lock a device or approver for 15 min after 5 tries.
- Access JWT 15 min, carries `tokenVersion`; the user is reloaded on every request, so disabling someone or changing a password logs them out at once. Refresh token: httpOnly cookie, stored hashed, rotated on each use; reusing an old one revokes the whole session family.
- Permissions are checked on the server for every route. Discounts above the role's limit, voids, NC and cancelling cooked food need a manager PIN (`approval: { pin }`), and the approver is written to the audit log.
- Every body, query and param goes through `z.strictObject`: unknown fields are rejected, which also blocks `$` operator injection.
- Prices, taxes and totals are always computed on the server from the menu. Clients send ids and quantities only.
- Rate limits: auth 10/min/IP, OTP 3 per 15 min per login, public orders 10/min/IP and 30/hour/table, call-waiter 1/min/table, everything else 300/min/IP. The store is in memory; use Redis when running more than one instance.
- QR and tracking tokens are random 128-bit values; QR tokens can be rotated.
- Uploads: JPEG/PNG/WebP checked by file signature, 5 MB, 5 per request, streamed to Cloudinary.
- Idempotency keys on order, payment and bill creation, so retries on bad networks don't double-charge.
- Logs redact auth headers, cookies, passwords, PINs, OTPs and tokens. Production errors return `code` and `message` only.
- The audit log is append-only (update/delete hooks throw).

## Tests

`npm test` covers: GST maths (inclusive/exclusive, mixed rates with discount, service charge, round-off, every printed bill adds up), the full dine-in flow (order → KOT → bill → split payment → settled → reports → refund → void → shift close), permissions and manager approval, instant logout on disable, refresh-token reuse detection, tenant isolation, idempotency, gapless bill numbers under concurrent billing, QR ordering (no client prices, acceptance, shared table, tracking, QR rotation), and realtime room isolation.

## Frontend

The frontend is moving from the old ASP.NET API to this one. The mapping table at the end of API.md lists every call that changes.
