import multer from 'multer';
import { badRequest } from '../lib/errors.js';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.includes(file.mimetype)),
});

// The mimetype comes from the client; check the actual bytes too.
export function assertImage(buffer) {
  const b = buffer.subarray(0, 12);
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!jpeg && !png && !webp) throw badRequest('Only JPEG, PNG or WebP images are allowed');
}
