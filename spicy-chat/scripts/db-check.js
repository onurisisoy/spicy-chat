#!/usr/bin/env node
/**
 * MongoDB bağlantı kontrolü. HİÇBİR ŞEY YAZMAZ.
 *   npm run db:check
 * Kontrol eder: bağlantı, kimlik doğrulama, roller, sunucu sürümü,
 * koleksiyonlar ve beklenen index'lerin olup olmadığı.
 */
import { getConfig, redactUri, ConfigError } from '../src/config.js';
import { createMongoClient } from '../src/db/mongo.js';
import { indexSpecs } from '../src/db/indexes.js';

const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const fail = (m) => console.log(`  ✖ ${m}`);

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
    console.log('DB_DRIVER=memory, kontrol edilecek MongoDB yok.');
    return;
  }

  console.log(`\nAdres : ${redactUri(cfg.mongo.uri)}`);
  console.log(`DB    : ${cfg.mongo.dbName}`);
  console.log(`TLS   : ${cfg.mongo.options.tls ? 'açık' : 'kapalı'}\n`);

  const client = createMongoClient(cfg);
  const started = Date.now();
  try {
    await client.connect();
    const db = client.db(cfg.mongo.dbName);
    await db.command({ ping: 1 });
    ok(`Bağlantı kuruldu (${Date.now() - started} ms)`);

    try {
      const info = await db.admin().command({ buildInfo: 1 });
      ok(`MongoDB sürümü: ${info.version}`);
      const major = Number(String(info.version).split('.')[0]);
      if (major < 5) warn('MongoDB 5.0 altı. Bu sürücü 4.2+ destekler ama 6.0+ önerilir.');
    } catch {
      warn('Sunucu sürümü okunamadı (yetki yok olabilir, sorun değil)');
    }

    const status = await db.command({ connectionStatus: 1 });
    const users = status.authInfo?.authenticatedUsers || [];
    const roles = status.authInfo?.authenticatedUserRoles || [];
    if (users.length) {
      ok(`Kullanıcı: ${users.map((u) => `${u.user}@${u.db}`).join(', ')}`);
      ok(`Roller : ${roles.map((r) => `${r.role}@${r.db}`).join(', ') || '(yok)'}`);
      const canWrite = roles.some(
        (r) => ['readWrite', 'dbOwner', 'root', 'readWriteAnyDatabase'].includes(r.role) && [cfg.mongo.dbName, 'admin'].includes(r.db),
      );
      if (canWrite) ok(`"${cfg.mongo.dbName}" veritabanına yazma yetkisi var`);
      else fail(`"${cfg.mongo.dbName}" için readWrite rolü görünmüyor. scripts/mongo/create-user.js'e bak.`);
    } else {
      warn('Kimlik doğrulaması yapılmadan bağlanıldı. Canlıda mutlaka kullanıcı/şifre kullan.');
    }

    try {
      const hello = await db.admin().command({ hello: 1 });
      if (hello.setName) ok(`Replica set: ${hello.setName} (${hello.hosts?.length || 0} üye)`);
      else ok('Tek sunucu (replica set değil)');
    } catch {
      /* yetki yoksa geç */
    }

    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const specs = indexSpecs(cfg.retentionDays);
    let missingIndexes = 0;
    for (const [coll, list] of Object.entries(specs)) {
      if (!existing.has(coll)) {
        warn(`"${coll}" koleksiyonu yok (ilk kayıtla ya da db:indexes ile oluşur)`);
        missingIndexes += list.length;
        continue;
      }
      const have = new Set((await db.collection(coll).indexes()).map((i) => i.name));
      const count = await db.collection(coll).estimatedDocumentCount();
      const missing = list.filter((s) => !have.has(s.name)).map((s) => s.name);
      missingIndexes += missing.length;
      if (missing.length) warn(`${coll} (${count} kayıt): eksik index → ${missing.join(', ')}`);
      else ok(`${coll} (${count} kayıt): index'ler tamam`);
    }
    if (missingIndexes) console.log('\n  Eksik index\'leri oluşturmak için: npm run db:indexes');
    console.log('\nSonuç: bağlantı ayarları çalışıyor.\n');
  } catch (e) {
    fail(`Bağlanılamadı: ${e.message}`);
    console.log('\nOlası nedenler:');
    console.log('  - Sunucu adresi/port yanlış ya da firewall 27017\'yi kapatıyor');
    console.log('  - mongod.conf içinde bindIp sadece 127.0.0.1 (uzaktan bağlanıyorsan SSH tüneli kullan)');
    console.log('  - Kullanıcı adı/şifre ya da authSource yanlış');
    console.log('  - Replica set adı yanlış ya da tek sunucuda directConnection=true gerekiyor');
    console.log('  - TLS açık ama MONGODB_TLS=false (ya da tersi)\n');
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main();
