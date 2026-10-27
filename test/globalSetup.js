import { MongoMemoryReplSet } from 'mongodb-memory-server';

// A replica set, because billing uses transactions.
export default async function ({ provide }) {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 120_000 }],
  });
  provide('mongoUri', rs.getUri());
  return () => rs.stop();
}
