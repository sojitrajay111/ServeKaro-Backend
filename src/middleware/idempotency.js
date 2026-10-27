import mongoose from 'mongoose';
import { badRequest, conflict } from '../lib/errors.js';

const Idem = mongoose.model('IdempotencyKey', new mongoose.Schema({
  scope: { type: String, required: true },
  key: { type: String, required: true },
  status: { type: String, enum: ['pending', 'done'], default: 'pending' },
  statusCode: Number,
  body: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
}).index({ scope: 1, key: 1 }, { unique: true }));

// Same Idempotency-Key from the same caller on the same route returns the first
// response instead of doing the work again. Server errors free the key for a retry.
export async function idempotent(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (key.length > 100) throw badRequest('Idempotency-Key is too long');

  const scope = `${req.user?._id ?? req.ip}:${req.method}:${req.originalUrl.split('?')[0]}`;

  try {
    await Idem.create({ scope, key });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const prev = await Idem.findOne({ scope, key }).lean();
    if (prev?.status === 'done') return res.status(prev.statusCode).json(prev.body);
    throw conflict('REQUEST_IN_PROGRESS', 'This request is already being processed');
  }

  // Save the response before sending it, so a quick retry finds it.
  const json = res.json.bind(res);
  res.json = (body) => {
    const done = res.statusCode < 500
      ? Idem.updateOne({ scope, key }, { status: 'done', statusCode: res.statusCode, body: JSON.parse(JSON.stringify(body)) })
      : Idem.deleteOne({ scope, key });
    done.catch(() => {}).finally(() => json(body));
    return res;
  };
  next();
}
