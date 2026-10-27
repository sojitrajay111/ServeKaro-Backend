import { inject, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

// Each test file gets its own database.
beforeAll(async () => {
  const uri = new URL(inject('mongoUri'));
  uri.pathname = `/t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await mongoose.connect(uri.toString());
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
