#!/usr/bin/env node
/**
 * Koleksiyonları ve index'leri oluşturur. Var olanlara dokunmaz.
 *   npm run db:indexes
 * Bu komut veritabanına YAZAR; kendin çalıştır.
 */
import { getConfig, redactUri, ConfigError } from '../src/config.js';
import { createMongoClient } from '../src/db/mongo.js';
import { ensureIndexes } from '../src/db/indexes.js';

async function main() {
  let cfg;
  try {
    cfg = getConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  if (cfg.dbDriver !== 'mongo') {
    console.log('DB_DRIVER=memory, oluşturulacak index yok.');
    return;
  }
  console.log(`\n${redactUri(cfg.mongo.uri)} → ${cfg.mongo.dbName}`);
  console.log(`Saklama süresi: ${cfg.retentionDays > 0 ? `${cfg.retentionDays} gün (TTL index kurulacak)` : 'süresiz'}\n`);
  const client = createMongoClient(cfg);
  try {
    await client.connect();
    await ensureIndexes(client.db(cfg.mongo.dbName), cfg.retentionDays, { info: (m) => console.log(`  ✔ ${m}`) });
    console.log('\nTamam.\n');
  } catch (e) {
    console.error(`\n  ✖ ${e.message}`);
    if (/IndexOptionsConflict|IndexKeySpecsConflict|already exists with different options/i.test(e.message)) {
      console.error('  Aynı isimde farklı ayarlı bir index var (örneğin saklama süresini değiştirdin).');
      console.error('  mongosh ile eski index\'i silip tekrar çalıştır: db.messages.dropIndex("ttl_created")');
    }
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main();
