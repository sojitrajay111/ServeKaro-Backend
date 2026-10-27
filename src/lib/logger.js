import pino from 'pino';
import env from '../config/env.js';

const logger = pino({
  level: env.isTest ? 'silent' : env.isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-device-token"]',
      '*.password', '*.newPassword', '*.currentPassword', '*.pin', '*.otp', '*.token',
    ],
    censor: '[hidden]',
  },
});

export default logger;
