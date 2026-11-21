import { createMemoryRepo } from './memory.js';

export async function createRepo(cfg, log) {
  if (cfg.dbDriver === 'memory') return createMemoryRepo(log);
  const { createMongoRepo } = await import('./mongo.js');
  return createMongoRepo(cfg, log);
}
