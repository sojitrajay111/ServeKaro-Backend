import 'dotenv/config';

const required = ['MONGO_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'FRONTEND_URL'];

const missing = required.filter((k) => !process.env[k]);
if (missing.length && process.env.NODE_ENV !== 'test') {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET || 'test-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'test-refresh-secret',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:8080').split(',').map((s) => s.trim()),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:8080',
  cloudinaryUrl: process.env.CLOUDINARY_URL,
  smtpUrl: process.env.SMTP_URL,
  mailFrom: process.env.MAIL_FROM || 'ServeKaro <no-reply@servekaro.com>',
};

export default env;
