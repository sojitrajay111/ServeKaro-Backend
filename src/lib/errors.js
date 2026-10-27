export class AppError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export const badRequest = (message, errors) => new AppError(400, 'VALIDATION_ERROR', message, errors);
export const unauthenticated = (message = 'Please log in again') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, message) => new AppError(409, code, message);
