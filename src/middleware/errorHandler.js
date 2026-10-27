import multer from 'multer';
import { AppError } from '../lib/errors.js';
import logger from '../lib/logger.js';
import env from '../config/env.js';

export function notFoundRoute(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let body = { success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong' };

  if (err instanceof AppError) {
    status = err.status;
    body = { success: false, code: err.code, message: err.message };
    if (err.errors) body.errors = err.errors;
  } else if (err.name === 'CastError') {
    status = 404;
    body = { success: false, code: 'NOT_FOUND', message: 'Not found' };
  } else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyPattern || {}).filter((k) => k !== 'restaurantId' && k !== 'outletId').pop();
    body = { success: false, code: 'DUPLICATE', message: `${field || 'Value'} already exists` };
    if (field) body.errors = { [field]: ['Already in use'] };
  } else if (err instanceof multer.MulterError) {
    status = 400;
    body = { success: false, code: 'UPLOAD_ERROR', message: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5 MB' : err.message };
  } else if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    status = err.status || 400;
    body = { success: false, code: 'BAD_REQUEST', message: 'Invalid request body' };
  }

  if (status >= 500) {
    logger.error({ err, url: req.originalUrl, method: req.method }, 'request failed');
    if (!env.isProd) body.message = err.message;
  }

  res.status(status).json(body);
}
