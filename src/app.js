import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import env from './config/env.js';
import logger from './lib/logger.js';
import { generalLimiter } from './middleware/limits.js';
import { errorHandler, notFoundRoute } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/routes.js';
import publicRoutes from './modules/public/routes.js';
import outletRoutes from './modules/outlets/routes.js';
import staffRoutes from './modules/staff/routes.js';
import taxRoutes from './modules/taxes/routes.js';
import menuRoutes from './modules/menu/routes.js';
import tableRoutes from './modules/tables/routes.js';
import orderRoutes from './modules/orders/routes.js';
import billRoutes from './modules/bills/routes.js';
import shiftRoutes from './modules/shifts/routes.js';
import reportRoutes from './modules/reports/routes.js';

const app = express();

app.set('trust proxy', 1); // behind one proxy (Render/Railway/Nginx); needed for real client IPs
app.disable('x-powered-by');

app.use(helmet());
app.use(cors({
  origin: env.corsOrigins,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Outlet-Id', 'Idempotency-Key', 'X-Device-Token', 'If-None-Match'],
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
if (!env.isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

app.get('/health', (req, res) => {
  const db = mongoose.connection.readyState === 1;
  res.status(db ? 200 : 503).json({ ok: db });
});

const api = express.Router();
api.use(generalLimiter);
api.use('/auth', authRoutes);
api.use('/public', publicRoutes);
// These share the root and scope their own auth middleware to their paths.
api.use(outletRoutes, staffRoutes, taxRoutes, menuRoutes, tableRoutes, orderRoutes, billRoutes, shiftRoutes, reportRoutes);

app.use('/api/v1', api);
app.use(notFoundRoute);
app.use(errorHandler);

export default app;
