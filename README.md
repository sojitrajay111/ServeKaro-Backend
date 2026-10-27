# ServeKaro Backend

New backend for ServeKaro, replacing the old ASP.NET API (`menubackend.runasp.net`).

**Stack:** Node.js · NestJS · MongoDB Atlas (Mongoose) · Socket.IO · JWT auth

Not started yet. The frontend's current API contract is in
`../servekaro-frontend/src/services/endpoints.ts` and
`../servekaro-frontend/MenuBackend API.postman_collection.json`.

## Rules for billing data

- Money is stored as integer paise (₹120.50 → `12050`), never as decimals.
- A bill, its payments and the order status are saved in one MongoDB transaction.
- Bill numbers are sequential with no gaps (GST), generated from a counter
  collection with an atomic `$inc`.
- A finished bill is never edited: cancel or credit-note it and issue a new one.
