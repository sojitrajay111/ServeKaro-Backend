export const ok = (res, data = null, status = 200) => res.status(status).json({ success: true, data });

export const created = (res, data) => ok(res, data, 201);

export const list = (res, data, { page, limit, total }) =>
  res.json({ success: true, data, meta: { page, limit, total } });

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
