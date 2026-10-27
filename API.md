# ServeKaro API v1

Base URL: `/api/v1`. JSON, camelCase. Phase tags: **[1]** build first, **[2]** next, **[3]** later. See README for what each phase means.

## Conventions

**Envelope.** Success: `{ "success": true, "data": ..., "meta": { "page", "limit", "total" } }` (`meta` only on lists).
Error: `{ "success": false, "code": "TABLE_OCCUPIED", "message": "Table 4 already has an open order", "errors": { "field": ["msg"] } }`.

| Status | When |
|---|---|
| 400 `VALIDATION_ERROR` | bad body/query |
| 401 `UNAUTHENTICATED` | missing/expired token (frontend logs out on this, so use it only for this) |
| 403 `FORBIDDEN` | logged in, missing permission |
| 404 `NOT_FOUND` | |
| 409 | state conflict, with a specific `code` (`BILL_ALREADY_SETTLED`, `ITEM_SOLD_OUT`, ...) |
| 429 `RATE_LIMITED` | |

**Ids** are opaque 24-character strings (MongoDB ObjectIds; the `itm_..` style below is just for readability). Treat them as strings, never `parseInt` them. Human numbers are separate fields: `orderNo`, `kotNo`, `billNo`. An id from another restaurant always gives 404.

**Money** is integer paise everywhere: `24900` = ₹249.00. **Quantity** is a number with up to 3 decimals (0.5 kg).

**Dates** are ISO 8601 UTC. Reports take `from`/`to` as dates in the outlet's timezone.

**Lists** take `?page=1&limit=50` (max 200), and `?q=` where search makes sense.

**Outlet scope.** Staff tokens carry the outlets a user can access. Outlet-scoped endpoints read `X-Outlet-Id`; it's optional when the user has exactly one outlet.

**Idempotency.** `POST /orders`, `POST /orders/:id/items`, `POST /bills`, `POST /bills/:id/payments` and `POST /public/orders` accept an `Idempotency-Key` header. The same key within 24h returns the first result instead of creating a duplicate. POS terminals retry on bad networks; this keeps them from double-billing.

**Auth.** `Authorization: Bearer <accessToken>`. Access token 15 min, refresh token 30 days (httpOnly cookie, rotated on every use).

---

## Permissions

Roles are named sets of these keys. Default roles are created at signup and can be edited.

```
menu.view      menu.edit        tables.manage
orders.create  orders.cancelItem  orders.accept      kot.update
bills.create   bills.discount   bills.void        bills.reprint   bills.complimentary
payments.collect  payments.refund
customers.view customers.edit   inventory.view    inventory.edit
shift.manage   expenses.edit    reports.view      staff.manage    settings.edit
```

| Default role | Gets |
|---|---|
| Owner | everything (can't be edited or deleted) |
| Manager | everything except `staff.manage`, `settings.edit` |
| Cashier | orders.*, bills.create/reprint, payments.collect, customers.*, shift.manage |
| Captain (waiter) | menu.view, orders.create, orders.accept, tables.manage |
| Chef | kot.update |

Discount above the role's limit (`role.maxDiscountPercent`) or any void needs a manager PIN in the same request: `{ "approval": { "pin": "4821" } }`. Every such action goes to the audit log.

---

## Shapes

**Money breakdown** (on orders and bills)
```json
{ "subtotal": 49800, "discount": 4980, "serviceCharge": 0,
  "taxes": [ { "name": "CGST", "rate": 2.5, "taxable": 44820, "amount": 1121 },
             { "name": "SGST", "rate": 2.5, "taxable": 44820, "amount": 1121 } ],
  "roundOff": -62, "total": 47000 }
```

**MenuItem**
```json
{ "id": "itm_..", "categoryId": "cat_..", "name": "Paneer Tikka", "shortCode": "PT",
  "description": "", "foodType": "veg" | "nonveg" | "egg", "price": 24900,
  "variants": [ { "id": "var_..", "name": "Half", "price": 14900 }, { "id": "var_..", "name": "Full", "price": 24900 } ],
  "addonGroupIds": ["adg_.."], "taxGroupId": "tax_..", "hsn": "996331",
  "stationId": "stn_..", "prepTimeMin": 15, "tags": ["popular", "chefSpecial", "new"],
  "inStock": true, "isActive": true, "images": [ { "id": "img_..", "url": "...", "isPrimary": true } ],
  "orderTypePrices": { "delivery": 26900 }, "sortOrder": 3 }
```
`variants` empty → `price` is used. `orderTypePrices` overrides price per order type.

**Order**
```json
{ "id": "ord_..", "orderNo": 112, "type": "dine_in" | "takeaway" | "delivery",
  "source": "pos" | "qr" | "zomato" | "swiggy",
  "status": "awaiting_acceptance" | "open" | "billed" | "settled" | "cancelled",
  "tableId": "tbl_..", "covers": 4, "captainId": "usr_..", "customerId": "cus_..",
  "items": [ { "id": "oi_..", "itemId": "itm_..", "name": "Paneer Tikka", "variantName": "Full",
               "addons": [ { "name": "Extra cheese", "price": 3000 } ], "qty": 2,
               "unitPrice": 27900, "note": "less spicy", "kotId": "kot_..",
               "status": "active" | "cancelled", "cancelReason": null } ],
  "amounts": { ...money breakdown },
  "billId": null, "trackingToken": "...", "createdAt": "...", "updatedAt": "..." }
```
Names and prices are copied into the order when items are added. Editing the menu never changes past orders.

**KOT** (kitchen order ticket)
```json
{ "id": "kot_..", "kotNo": 57, "orderId": "ord_..", "orderNo": 112, "tableName": "T4",
  "stationId": "stn_..", "type": "new" | "cancel",
  "items": [ { "orderItemId": "oi_..", "name": "Paneer Tikka", "variantName": "Full", "addons": [], "qty": 2, "note": "" } ],
  "status": "pending" | "preparing" | "ready" | "served", "createdBy": "usr_..", "createdAt": "..." }
```
Each round of items added to an order makes one KOT per kitchen station. Cancelling a sent item makes a `cancel` KOT so the kitchen knows.

**Bill**
```json
{ "id": "bil_..", "billNo": "SK/26-27/000123", "orderId": "ord_..",
  "lines": [ { "name": "Paneer Tikka (Full)", "qty": 2, "unitPrice": 27900, "amount": 55800, "hsn": "996331", "taxRate": 5 } ],
  "amounts": { ...money breakdown },
  "discounts": [ { "kind": "percent" | "flat", "value": 10, "amount": 4980, "reason": "Regular", "approvedBy": "usr_.." } ],
  "payments": [ { "id": "pay_..", "mode": "cash" | "card" | "upi" | "wallet" | "online" | "due", "amount": 47000, "reference": "", "receivedBy": "usr_..", "at": "..." } ],
  "paid": 47000, "due": 0,
  "status": "unpaid" | "partly_paid" | "paid" | "void",
  "isComplimentary": false, "customer": { "name": "", "phone": "", "gstin": "" },
  "voidReason": null, "createdBy": "usr_..", "createdAt": "..." }
```
Bill numbers are per outlet, per financial year, gapless. A void bill keeps its number.

---

## 1. Auth [1]

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/auth/signup` | public | `{ restaurantName, outletName, city, ownerName, email, phone, password }` | `{ accessToken, user, restaurant, outlet }`. Creates restaurant + first outlet + Owner + default roles and tax groups. Sends email verification. |
| POST | `/auth/verify-email` | public | `{ token }` | `null` |
| POST | `/auth/login` | public | `{ login, password }` (email or phone) | `{ accessToken, user, outlets }` + refresh cookie |
| POST | `/auth/pin-login` | device | `{ pin }` (4–6 digits) + header `X-Device-Token` | `{ accessToken, outletId, user, role, permissions, outlets }`. Fast staff switching on a shared POS terminal. No refresh cookie. 5 wrong PINs lock the device for 15 min. |
| POST | `/auth/refresh` | cookie | none | `{ accessToken }` |
| POST | `/auth/logout` | staff | none | `null`. Revokes the refresh token. |
| GET | `/auth/me` | staff | none | `{ user, role, permissions, outlets }` |
| PATCH | `/auth/me` | staff | `{ name, email, phone }` | user |
| POST | `/auth/change-password` | staff | `{ currentPassword, newPassword }` | `null`. Revokes other sessions. |
| POST | `/auth/forgot-password` | public | `{ login }` | `null`. Always 200. Sends a 6-digit OTP. |
| POST | `/auth/reset-password` | public | `{ login, otp, newPassword }` | `null`. Logs out every session. |
| POST | `/auth/accept-invite` | public | `{ token, password }` | `null`. Token comes from the invite email link `/admin/accept-invite?token=`. |
| POST | `/auth/devices` | settings.edit | `{ name }` | `{ device, deviceToken }`. Registers a POS terminal for PIN login. The token is shown once. |
| GET | `/auth/devices` | settings.edit | none | devices of the current outlet |
| DELETE | `/auth/devices/:id` | settings.edit | none | `null` |

`login`, `signup`, `me`, `pin-login` all return the same profile: `{ user, role: { id, name, isOwner, maxDiscountPercent }, permissions, outlets: [{ id, name, slug, city }] }`.

## 2. Restaurant, outlets, settings [1]

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET / PATCH | `/restaurant` | settings.edit | brand: name, logo, legal name, PAN |
| GET | `/outlets` | staff | outlets this user can access |
| POST | `/outlets` | Owner | **[3]** multi-outlet |
| GET / PATCH | `/outlets/:id` | settings.edit | profile and settings below |

Outlet settings:
```json
{ "name", "slug", "address", "phone", "email", "gstin", "fssai", "timezone": "Asia/Kolkata",
  "billPrefix": "SK", "financialYearStart": "04-01",
  "pricesIncludeTax": false, "roundOff": "nearest_rupee" | "none",
  "serviceCharge": { "enabled": false, "percent": 5, "orderTypes": ["dine_in"] },
  "orderTypes": ["dine_in", "takeaway", "delivery"],
  "qrOrdering": { "enabled": true, "requireAcceptance": true, "allowPayLater": true },
  "bill": { "header": "", "footer": "Thank you!", "showItemTax": false },
  "theme": { "primaryColor": "#FF6B35", "accentColor": "#F7931E", "logoUrl": "" },
  "isOpen": true }
```

## 3. Staff & roles [1]

| Method | Path | Perm | Body / notes |
|---|---|---|---|
| GET | `/staff` | staff.manage | list |
| POST | `/staff` | staff.manage | `{ name, phone, email?, roleId, outletIds, pin? }`. Sends an invite to set a password. |
| PATCH | `/staff/:id` | staff.manage | same fields, `isActive` |
| POST | `/staff/:id/reset-pin` | staff.manage | `{ pin }`. 409 `PIN_TAKEN` if someone else in the restaurant has it. |
| POST | `/staff/:id/resend-invite` | staff.manage | none |
| GET | `/roles` | staff.manage | `{ roles, permissions }` (all permission keys, for the role editor) |
| POST | `/roles` | staff.manage | `{ name, permissions[], maxDiscountPercent }` |
| PATCH / DELETE | `/roles/:id` | staff.manage | 409 if users still have it |

## 4. Taxes [1]

| Method | Path | Perm | Body |
|---|---|---|---|
| GET / POST | `/tax-groups` | settings.edit | `{ name: "GST 5%", components: [ { "name": "CGST", "rate": 2.5 }, { "name": "SGST", "rate": 2.5 } ] }` |
| PATCH / DELETE | `/tax-groups/:id` | settings.edit | 409 on delete if items use it |

Seeded at signup: GST 0%, 5%, 12%, 18%. Tax is calculated per line after the line's share of the discount.

## 5. Menu [1]

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/menu` | menu.view | full menu in one call: categories with items, addon groups. POS loads this once and caches it. Supports `If-None-Match` (ETag). |
| GET / POST | `/categories` | menu.edit | `{ name, sortOrder, isActive, availability?: { days, from, to } }` |
| PATCH / DELETE | `/categories/:id` | menu.edit | 409 on delete if it has items |
| PUT | `/categories/order` | menu.edit | `{ ids: [...] }` sets sort order |
| GET | `/items` | menu.view | `?categoryId=&q=&inStock=` |
| POST | `/items` | menu.edit | MenuItem without `id`/`images` |
| GET / PATCH / DELETE | `/items/:id` | menu.edit | delete = soft delete (`isActive: false`); old bills still reference it |
| PATCH | `/items/:id/stock` | menu.view | `{ inStock }`. Captains and cashiers can mark sold out. |
| POST | `/items/:id/images` | menu.edit | multipart `images` (≤5, jpeg/png/webp, 5 MB) |
| PATCH / DELETE | `/items/:id/images/:imageId` | menu.edit | `{ isPrimary }` |
| GET / POST | `/addon-groups` | menu.edit | `{ name, min, max, addons: [ { name, price, foodType } ] }` |
| PATCH / DELETE | `/addon-groups/:id` | menu.edit | |
| GET / POST | `/stations` | settings.edit | kitchen sections for KOT routing: `{ name: "Tandoor" }` |
| POST | `/menu/import` | menu.edit | **[2]** CSV upload, returns row errors without saving anything if any row fails |

## 6. Areas & tables [1]

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET / POST | `/areas` | tables.manage | `{ name: "Rooftop", sortOrder }` |
| PATCH / DELETE | `/areas/:id` | tables.manage | |
| GET | `/tables` | staff | `?areaId=`. Each has `status: "free" | "occupied" | "billed"`, `orderId`, `since`, `amount`. |
| GET | `/tables/:id` | staff | one table, with `qrUrl` |
| POST | `/tables` | tables.manage | `{ name: "T4", areaId, capacity }`. Generates `qrToken`; responses include `qrUrl`. |
| PATCH / DELETE | `/tables/:id` | tables.manage | 409 on delete if occupied |
| POST | `/tables/:id/qr/rotate` | tables.manage | new `qrToken`; old printed QR stops working |
| GET | `/tables/qr.pdf` | tables.manage | **[2]** printable sheet of all QR codes |
| POST | `/tables/:id/transfer` | orders.create | `{ toTableId }` moves the open order |
| POST | `/tables/merge` | orders.create | `{ tableIds: [...] }` merges open orders into the first |

QR URL format: `https://<frontend>/t/<qrToken>`. The token is random (not the table number) so nobody can order to another table by editing the URL.

## 7. Orders & KOT [1]

| Method | Path | Perm | Body / notes |
|---|---|---|---|
| GET | `/orders` | staff | `?status=&type=&tableId=&from=&to=` |
| POST | `/orders` | orders.create | `{ type, tableId?, covers?, customer?: { name, phone }, items: [ { itemId, variantId?, addonIds?, qty, note? } ], sendKot: true }`. Prices come from the menu, never from the client. 409 `TABLE_OCCUPIED` if the table has an open order. |
| GET | `/orders/:id` | staff | |
| POST | `/orders/:id/items` | orders.create | `{ items: [...], sendKot: true }`. Adds a round, creates KOTs. |
| POST | `/orders/:id/kot` | orders.create | sends a KOT for items saved with `sendKot: false` |
| POST | `/orders/:id/items/:itemId/cancel` | orders.cancelItem | `{ qty, reason }`. Creates a cancel KOT if already sent. |
| PATCH | `/orders/:id` | orders.create | `{ covers, customer, note, captainId }` |
| POST | `/orders/:id/accept` | orders.accept | for `awaiting_acceptance` QR orders, sends KOTs |
| POST | `/orders/:id/reject` | orders.accept | `{ reason }` |
| POST | `/orders/:id/cancel` | orders.cancelItem | `{ reason }`. Only if not billed. Manager approval if KOT already sent. |
| GET | `/kots` | staff | `?status=pending,preparing&stationId=`. Kitchen display. |
| PATCH | `/kots/:id` | kot.update | `{ status }`: pending → preparing → ready → served |
| POST | `/kots/:id/reprint` | orders.create | logs a reprint, emits print event |

## 8. Bills & payments [1]

| Method | Path | Perm | Body / notes |
|---|---|---|---|
| POST | `/bills` | bills.create | `{ orderId, discount?: { kind, value, reason }, customer?, approval? }`. Generates billNo, order → `billed`, table → `billed`. One bill per order (v1). |
| GET | `/bills` | reports.view | `?status=&from=&to=&q=billNo` |
| GET | `/bills/:id` | staff | |
| PATCH | `/bills/:id/discount` | bills.discount | only while `unpaid`. Recalculates. |
| POST | `/bills/:id/payments` | payments.collect | `{ mode, amount, reference? }`. Split payment = several calls. When `due` hits 0: bill → `paid`, order → `settled`, table → `free`. |
| POST | `/bills/:id/payments/:paymentId/refund` | payments.refund | `{ amount, reason }` |
| POST | `/bills/:id/void` | bills.void | `{ reason, approval, reopenOrder? }`. Refund all payments first (409 `PAYMENTS_EXIST`). Number is kept; the order reopens (`reopenOrder: true`) or is cancelled. |
| POST | `/bills/:id/complimentary` | bills.complimentary | `{ reason, approval }`. Total 0, kept in reports as NC. |
| POST | `/bills/:id/reprint` | bills.reprint | audit-logged, prints "DUPLICATE" |
| GET | `/bills/:id/pdf` | staff | **[2]** A4 / 80mm invoice |
| POST | `/bills/:id/send` | staff | **[2]** `{ channel: "sms" | "whatsapp" | "email" }` e-bill |
| POST | `/bills/split` | bills.create | **[2]** `{ orderId, splits: [ { orderItemIds } ] or { equalParts: 3 } }` |

Bill creation, payment and status changes are each one MongoDB transaction.

## 9. Shifts & cash [1]

| Method | Path | Perm | Body / notes |
|---|---|---|---|
| GET | `/shifts/current` | staff | open shift for this outlet/terminal, or null |
| POST | `/shifts/open` | shift.manage | `{ openingCash }` |
| POST | `/shifts/current/cash` | shift.manage | `{ kind: "in" | "out", amount, reason }` petty cash |
| POST | `/shifts/current/close` | shift.manage | `{ countedCash, denominations? }`. Returns expected vs counted, difference. |
| GET | `/shifts` | reports.view | history |
| GET | `/day-end` | reports.view | `?date=` Z-report: sales by mode, tax, discounts, voids, NC, cash difference |

Collecting a payment needs an open shift (409 `NO_OPEN_SHIFT`).

## 10. Customers [2]

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/customers` | customers.view | `?q=` name/phone |
| POST / PATCH | `/customers`, `/customers/:id` | customers.edit | `{ name, phone, email, birthday, anniversary, gstin, notes, tags }` |
| GET | `/customers/:id/orders` | customers.view | history, total spend, last visit |
| GET | `/customers/:id/ledger` | customers.view | credit (`due` payments) and settlements |
| POST | `/customers/:id/settle` | payments.collect | pay off credit |
| | loyalty | | **[3]** points per ₹, redeem at billing |

Phone is unique per restaurant and stored normalised (`+91XXXXXXXXXX`).

## 11. Discounts & coupons [2]

| Method | Path | Perm | Body |
|---|---|---|---|
| GET / POST | `/discounts` | settings.edit | `{ name, kind, value, maxAmount?, minBill?, appliesTo: "bill" | { categoryIds, itemIds }, orderTypes, validFrom, validTo, days?, hours?, code? }` |
| PATCH / DELETE | `/discounts/:id` | settings.edit | |

Billing accepts `{ discountId }` or `{ code }` instead of a manual discount.

## 12. Inventory [2]

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET / POST / PATCH | `/materials` | inventory.edit | `{ name, unit: "kg" | "g" | "l" | "ml" | "pcs", reorderLevel, costPerUnit }` |
| GET / POST / PATCH | `/vendors` | inventory.edit | `{ name, phone, gstin }` |
| POST | `/purchases` | inventory.edit | `{ vendorId, invoiceNo, date, lines: [ { materialId, qty, rate } ] }`. Stock in. |
| GET / PUT | `/items/:id/recipe` | inventory.edit | `{ lines: [ { materialId, qty } ] }` per 1 unit (per variant if needed) |
| POST | `/stock/adjust` | inventory.edit | `{ materialId, qty, reason: "wastage" | "count" | "staff_meal" }` |
| GET | `/stock` | inventory.view | current stock, low-stock flag |
| GET | `/stock/ledger` | inventory.view | `?materialId=&from=&to=` |

Stock is deducted from recipes when a bill is paid, and added back when it's voided.

## 13. Expenses [2]

`GET / POST / PATCH / DELETE /expenses`: `{ category, amount, mode, paidTo, note, date, attachmentUrl? }` (expenses.edit). Cash expenses during a shift count as cash out.

## 14. Reports [1 core, 2 rest]

All `GET`, all need `reports.view`, all take `from`, `to`, and `format=json|csv`.

| Path | Phase | What |
|---|---|---|
| `/reports/dashboard` | 1 | today: sales, orders, avg bill, covers, running tables, top items, sales by hour |
| `/reports/sales` | 1 | by day: gross, discount, tax, net, NC, voids, orders, covers |
| `/reports/payments` | 1 | by mode |
| `/reports/items` | 1 | qty and amount per item / variant, `?categoryId=` |
| `/reports/categories` | 1 | |
| `/reports/tax` | 1 | GST summary by rate, HSN-wise (for GSTR-1) |
| `/reports/discounts` | 2 | who, why, how much |
| `/reports/cancellations` | 2 | cancelled items, voided bills, with reason and user |
| `/reports/staff` | 2 | sales per captain / cashier |
| `/reports/order-types` | 2 | dine-in / takeaway / delivery / per source |
| `/reports/inventory` | 2 | consumption vs purchase, variance |

## 15. Audit log [1]

`GET /audit-logs?action=&userId=&from=&to=` (reports.view). Written automatically for: bill void, complimentary, discount, reprint, item cancel after KOT, refund, price edits, role/permission changes, shift close difference, logins from new devices. Entries are never edited or deleted.

## 16. Public (customer QR ordering) [1]

No token. Rate limited per IP and per table.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/public/t/:qrToken` | `{ outlet: { name, slug, theme, isOpen, qrOrdering }, table: { id, name }, menu }`. One call loads the whole page. |
| GET | `/public/outlets/:slug/menu` | menu without a table (takeaway / browse only) |
| POST | `/public/orders` | `{ qrToken, customer: { name, phone }, items: [ { itemId, variantId?, addonIds?, qty, note? } ], note? }` → `{ orderId, orderNo, trackingToken, status }`. If the table already has an open order, the items are added to it as a new round. With `requireAcceptance` the order waits for staff. |
| GET | `/public/orders/:trackingToken` | `{ orderNo, status, items (with KOT status), amounts, bill? }` |
| POST | `/public/t/:qrToken/call-waiter` | `{ reason: "waiter" | "bill" | "water" }`. Throttled to 1/min/table. |
| POST | `/public/orders/:trackingToken/feedback` | **[2]** `{ rating: 1-5, comment }` |
| POST | `/public/orders/:trackingToken/pay` | **[3]** Razorpay/UPI pay at table, webhook settles the bill |

## 17. Online aggregators [3]

Via an integrator (UrbanPiper or similar), not directly with Zomato/Swiggy.

| Method | Path | Notes |
|---|---|---|
| POST | `/webhooks/aggregator` | signed webhook, HMAC verified. Creates order with `source`, `type: delivery`. |
| POST | `/orders/:id/aggregator/accept` / `reject` / `ready` | pushes status back |
| POST | `/items/:id/stock` | also pushes stock-out to aggregators |

## 18. Realtime (Socket.IO)

Path `/realtime`. Staff connect with `auth: { token }` and are joined to every outlet they can access. The client sends these and gets `{ ok }` back (use `emitWithAck`):

- `join:station` `{ stationId }`: staff only; kitchen screen for one station
- `join:order` `{ trackingToken }`: anyone; customer tracking their order
- `join:menu` `{ slug }`: anyone; live sold-out updates on the QR menu

A bad token fails the connection with `UNAUTHENTICATED`. Access tokens last 15 min, so pass `auth` as a function that returns the current token; reconnects then pick up the refreshed one.

| Event | Room | Payload |
|---|---|---|
| `order.created` | outlet | Order (QR orders included, with `status: awaiting_acceptance`) |
| `order.updated` | outlet, order | Order |
| `kot.created` | outlet, station | KOT |
| `kot.updated` | outlet, station, order | `{ id, orderId, status }` |
| `table.updated` | outlet | `{ id, status, orderId, amount }` |
| `bill.updated` | outlet | `{ id, orderId, status, due }` |
| `menu.stock` | outlet, public menu viewers | `{ itemId, inStock }` |
| `waiter.called` | outlet | `{ tableId, tableName, reason }` |
| `print` | outlet | `{ kind: "kot" | "bill", id, stationId }`. Picked up by the print agent. |

Events go out after the DB transaction commits. Clients should refetch on reconnect, because events missed while offline are not replayed.

## 19. Printing [2]

Browsers can't talk to thermal printers directly. A small local print agent (Node, runs on the counter PC) connects to the socket as a device, listens for `print`, fetches `GET /print/kots/:id` or `GET /print/bills/:id` (ESC/POS-ready text layout), and sends it to the printer mapped to that station. Until then, the frontend prints with `window.print()` and an 80mm stylesheet.

---

## Mapping from the current frontend

| Frontend calls today | New endpoint |
|---|---|
| `POST /Auth/login`, `/Auth/signup` | `/auth/login`, `/auth/signup` |
| `GET /Auth/profile`, `POST /Auth/update-profile` | `GET /auth/me`, `PATCH /auth/me` |
| `/Auth/forgot-password` → `verify-otp` → `reset-password` | `/auth/forgot-password` → `/auth/reset-password` (OTP sent with the new password) |
| `/Auth/create-waiter`, `/Auth/waiters` | `POST /staff`, `GET /staff` |
| `GET/PUT /Settings` | `GET/PATCH /outlets/:id` |
| `GET /Menu/categories`, `/Menu/items?CategoryID=`, `/items/search`, `/items/featured` | `GET /menu` (one call, filter on the client) or `GET /items?categoryId=&q=` |
| `POST /Menu/items`, `POST /Menu/categories` (upsert) | `POST` to create, `PATCH /:id` to update |
| `/MenuImage/*` | `/items/:id/images` |
| `/Table` | `/tables` |
| `POST /Order` (customer) | `POST /public/orders` |
| `GET /Order`, `/Order/kitchen`, `/Order/dashboard` | `GET /orders`, `GET /kots`, `GET /reports/dashboard` |
| `PUT /Order/:id/status` | `PATCH /kots/:id` (kitchen) and `POST /bills` + payments (billing) |
| SignalR `/orderHub` `ReceiveNewOrder` / `ReceiveStatusUpdate` | Socket.IO `/realtime` `order.created` / `kot.updated`, `order.updated` |
| `/my-orders` (in-memory) | `GET /public/orders/:trackingToken` + `join:order` |

Frontend code that has to change with it: `src/services/endpoints.ts`, `apiService.ts`, `store/menuApi.ts`, `hooks/useOrderHub.ts`, and every `parseInt(id)` (ids are strings now). Prices come in paise, so divide by 100 only when displaying.
