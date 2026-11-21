#!/usr/bin/env node
/**
 * .env ve config/*.json dosyalarını doğrular, özet basar. Hiçbir yere bağlanmaz.
 *   npm run config:check
 */
import { getConfig, redactUri, ConfigError } from '../src/config.js';

try {
  const c = getConfig();
  console.log('\nAyarlar geçerli.\n');
  console.log(`  Ortam        : ${c.nodeEnv}  (port ${c.port}, ${c.publicBaseUrl})`);
  console.log(`  Veritabanı   : ${c.dbDriver === 'mongo' ? `MongoDB ${redactUri(c.mongo.uri)} / ${c.mongo.dbName}` : 'bellek (memory)'}`);
  if (c.dbDriver === 'mongo') {
    const o = c.mongo.options;
    console.log(`                 pool ${o.minPoolSize}-${o.maxPoolSize}, timeout ${o.serverSelectionTimeoutMS} ms, w=${o.writeConcern.w}, TLS ${o.tls ? 'açık' : 'kapalı'}, auto-index ${c.mongo.autoIndex ? 'açık' : 'kapalı'}`);
  }
  console.log(`  Çeviri       : ${c.translation.provider}${c.translation.provider === 'anthropic' ? ` (${c.translation.anthropic.model})` : ''}, ekip dilleri ${c.translation.teamLangs.join('/')} → hedef ${c.translation.teamTargetLang}`);
  console.log(`  Telegram     : ${c.telegram.enabled ? `açık (grup ${c.telegram.groupId})` : 'kapalı'}`);
  console.log(`  E-posta      : ${c.email.smtpHost ? `SMTP ${c.email.smtpHost}:${c.email.smtpPort}` : `kapalı → ${c.email.outboxDir}`}`);
  console.log(`  Çalışma saati: ${c.support.hours} (${c.support.timezone})`);
  console.log(`  Siteler      : ${c.sites.map((s) => `${s.id} (${s.defaultLang})`).join(', ')}`);
  console.log(`  Ekip         : ${c.agents.map((a) => a.name).join(', ')}`);
  console.log(`  Test sayfası : ${c.serveTestPages ? `${c.publicBaseUrl}/test/` : 'kapalı'}\n`);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
