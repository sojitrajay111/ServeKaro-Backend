import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';

export const zId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const zMoney = z.number().int('Amount must be in paise').min(0).max(1e9);
export const zQty = z.number().positive().max(999).multipleOf(0.001);
export const zText = (max = 200) => z.string().trim().max(max);

export const zPaging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

// Turns zod issues into { "items.0.qty": ["Too small"] }.
function fieldErrors(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ||= []).push(issue.message);
  }
  return out;
}

/**
 * validate({ params, query, body }): each a zod schema. Objects should be
 * z.strictObject so unknown keys (including `$` operators) are rejected.
 */
export const validate = (schemas) => (req, res, next) => {
  for (const part of ['params', 'query', 'body']) {
    const schema = schemas[part];
    if (!schema) continue;
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      if (part === 'params') throw notFound();
      throw badRequest('Please check the highlighted fields', fieldErrors(result.error));
    }
    // req.query is a getter in Express 5, so redefine it.
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
  }
  next();
};

export const idParams = validate({ params: z.strictObject({ id: zId }) });
