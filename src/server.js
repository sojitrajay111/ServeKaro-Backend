import http from 'node:http';
import mongoose from 'mongoose';
import env from './config/env.js';
import logger from './lib/logger.js';
import { connectDb } from './lib/db.js';
import { attachSocket } from './socket.js';
import app from './app.js';

await connectDb(env.mongoUri);
logger.info('MongoDB connected');

const server = http.createServer(app);
const io = attachSocket(server);

server.listen(env.port, () => logger.info(`API on :${env.port}`));

const shutdown = async (signal) => {
  logger.info(`${signal}: shutting down`);
  io.close();
  server.close();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
