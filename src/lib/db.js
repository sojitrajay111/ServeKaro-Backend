import mongoose from 'mongoose';

// Query operator injection is blocked at the edge: every body, query and param
// goes through a strict zod schema, so user input can't carry `$` keys.
mongoose.set('strictQuery', true);

export async function connectDb(uri) {
  await mongoose.connect(uri, { autoIndex: true });
  return mongoose.connection;
}

// Runs fn in a transaction and retries on transient errors (driver-managed).
// Keep side effects (socket events, emails) outside fn: it may run twice.
export function withTransaction(fn) {
  return mongoose.connection.transaction((session) => fn(session));
}
