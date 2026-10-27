import { v2 as cloudinary } from 'cloudinary';
import env from '../config/env.js';
import { AppError } from './errors.js';

// cloudinary reads CLOUDINARY_URL from the environment by itself.
const enabled = Boolean(env.cloudinaryUrl);

export function uploadImage(buffer, folder) {
  if (!enabled) throw new AppError(503, 'UPLOADS_DISABLED', 'Image upload is not configured');
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder, resource_type: 'image' }, (err, res) =>
        err ? reject(err) : resolve({ url: res.secure_url, publicId: res.public_id }))
      .end(buffer);
  });
}

export async function deleteImage(publicId) {
  if (!enabled || !publicId) return;
  await cloudinary.uploader.destroy(publicId).catch(() => {});
}
