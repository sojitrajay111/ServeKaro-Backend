import rateLimit from 'express-rate-limit';
import env from '../config/env.js';

// In-memory store: fine for one instance. With several instances behind a load
// balancer, switch to rate-limit-redis.
const make = (windowMs, limit, keyGenerator) => rateLimit({
  windowMs,
  limit,
  keyGenerator,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.isTest,
  handler: (req, res) => res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many requests, please wait a moment',
  }),
});

const MIN = 60 * 1000;

export const generalLimiter = make(MIN, 300);
export const authLimiter = make(MIN, 10);
export const otpLimiter = make(15 * MIN, 3, (req) => `otp:${String(req.body?.login || '').toLowerCase()}`);
export const publicOrderLimiter = make(MIN, 10);
export const tableOrderLimiter = make(60 * MIN, 30, (req) => `table:${req.body?.qrToken || req.params?.qrToken}`);
export const callWaiterLimiter = make(MIN, 1, (req) => `call:${req.params.qrToken}`);
