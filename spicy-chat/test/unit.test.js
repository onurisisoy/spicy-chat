import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMongoUri, redactUri, loadConfig, ConfigError } from '../src/config.js';
import { guessLang, normalizeLang } from '../src/translate/langs.js';
import { protectXml, unprotectXml, findTerms } from '../src/translate/glossary.js';
import { parseHours, isWithinHours, createPresence } from '../src/util/presence.js';
import { signToken, verifyToken } from '../src/util/auth.js';
import { createRateLimiter } from '../src/util/ratelimit.js';
import { renderReplyEmail } from '../src/email/templates.js';
import { indexSpecs } from '../src/db/indexes.js';

const baseEnv = {
  PANEL_PASSWORD: 'x',
  __sites: [{ id: 's', defaultLang: 'sv', allowedOrigins: ['*'] }],
  __agents: [{ id: 'a', name: 'A' }],
};

test('Mongo URI: parçalardan, şifre encode edilir', () => {
  const uri = buildMongoUri({ MONGODB_HOSTS: '10.0.0.5:27017', MONGODB_USER: 'app', MONGODB_PASSWORD: 'p@ss:w/rd#1', MONGODB_DB: 'spicychat', MONGODB_DIRECT_CONNECTION: 'true' });
  assert.equal(uri, 'mongodb://app:p%40ss%3Aw%2Frd%231@10.0.0.5:27017/spicychat?authSource=spicychat&directConnection=true');
});

test('Mongo URI: replica set varken directConnection eklenmez', () => {
  const uri = buildMongoUri({ MONGODB_HOSTS: 'a:27017,b:27017', MONGODB_USER: 'u', MONGODB_PASSWORD: 'p', MONGODB_REPLICA_SET: 'rs0', MONGODB_AUTH_SOURCE: 'admin', MONGODB_DIRECT_CONNECTION: 'true' });
  assert.equal(uri, 'mongodb://u:p@a:27017,b:27017/spicychat?authSource=admin&replicaSet=rs0');
});

test('Mongo URI: MONGODB_URI doluysa aynen kullanılır', () => {
  assert.equal(buildMongoUri({ MONGODB_URI: 'mongodb://x/y', MONGODB_HOSTS: 'z' }), 'mongodb://x/y');
});

test('Mongo URI: kullanıcısız', () => {
  assert.equal(buildMongoUri({ MONGODB_HOSTS: '127.0.0.1:27017' }), 'mongodb://127.0.0.1:27017/spicychat');
});

test('redactUri şifreyi gizler', () => {
  assert.equal(redactUri('mongodb://app:secret@h:27017/db'), 'mongodb://app:****@h:27017/db');
});

test('Config: Mongo seçenekleri doğru kurulur', () => {
  const c = loadConfig({ ...baseEnv, MONGODB_HOSTS: 'h:1', MONGODB_USER: 'u', MONGODB_PASSWORD: 'p', MONGODB_WRITE_CONCERN: '1', MONGODB_MAX_POOL_SIZE: '5', MONGODB_TLS: 'true' }, { loadFiles: false });
  assert.equal(c.mongo.options.maxPoolSize, 5);
  assert.deepEqual(c.mongo.options.writeConcern, { w: 1 });
  assert.equal(c.mongo.options.tls, true);
  assert.equal(c.mongo.autoIndex, false);
});

test('Config: eksik ayarlar açıklayıcı hata verir', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, TRANSLATION_PROVIDER: 'anthropic', MONGODB_USER: 'u' }, { loadFiles: false }),
    (e) => e instanceof ConfigError && /ANTHROPIC_API_KEY/.test(e.message) && /MONGODB_PASSWORD/.test(e.message),
  );
});

test('Config: canlıda güvensiz ayarlar reddedilir', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, NODE_ENV: 'production', PANEL_PASSWORD: 'degistir-beni', SESSION_SECRET: 'kisa', DB_DRIVER: 'memory' }, { loadFiles: false }),
    (e) => /SESSION_SECRET/.test(e.message) && /PANEL_PASSWORD/.test(e.message),
  );
});

test('Dil tahmini', () => {
  assert.equal(guessLang('Hej! Finns det plats den 12 maj för två vuxna?'), 'sv');
  assert.equal(guessLang('Hei! Onko teillä tilaa toukokuussa?'), 'fi');
  assert.equal(guessLang('Hej! Er der ledige pladser? Jeg vil gerne have to værelser.'), 'da');
  assert.equal(guessLang('Merhaba, evet yer var. Teşekkürler!'), 'tr');
  assert.equal(guessLang('Hello, is there a room available?'), 'en');
  assert.equal(guessLang('12345', 'fi'), 'fi');
  assert.equal(normalizeLang('sv-SE'), 'sv');
  assert.equal(normalizeLang('no'), 'nb');
});

test('Sözlük koruması (DeepL XML)', () => {
  const xml = protectXml('Hotel i Alanya, all inclusive <3 info@spicy.se ref SPT-12345', ['Alanya', 'all inclusive']);
  assert.equal(xml, 'Hotel i <x>Alanya</x>, <x>all inclusive</x> &lt;3 <x>info@spicy.se</x> ref <x>SPT-12345</x>');
  assert.equal(unprotectXml(xml), 'Hotel i Alanya, all inclusive <3 info@spicy.se ref SPT-12345');
  assert.deepEqual(findTerms('resa till ALANYA', ['Alanya', 'Side']), ['Alanya']);
});

test('Çalışma saatleri', () => {
  const rules = parseHours('mon-fri 09:00-18:00;sat 10:00-14:00');
  // 2026-11-23 Pazartesi. Stockholm UTC+1
  assert.equal(isWithinHours(rules, 'Europe/Stockholm', new Date('2026-11-23T08:30:00Z')), true); // 09:30
  assert.equal(isWithinHours(rules, 'Europe/Stockholm', new Date('2026-11-23T17:30:00Z')), false); // 18:30
  assert.equal(isWithinHours(rules, 'Europe/Stockholm', new Date('2026-11-21T10:00:00Z')), true); // Cmt 11:00
  assert.equal(isWithinHours(rules, 'Europe/Stockholm', new Date('2026-11-22T10:00:00Z')), false); // Paz
  assert.throws(() => parseHours('pazartesi 9-5'));
  const p = createPresence({ hours: 'mon 09:00-10:00', timezone: 'UTC' });
  p.setMode('online');
  assert.equal(p.isOnline(new Date('2026-11-22T03:00:00Z')), true);
  p.setMode('offline');
  assert.equal(p.isOnline(new Date('2026-11-23T09:30:00Z')), false);
});

test('Panel token imzası', () => {
  const t = signToken({ sub: 'onur' }, 'secret');
  assert.equal(verifyToken(t, 'secret').sub, 'onur');
  assert.equal(verifyToken(t, 'baska'), null);
  assert.equal(verifyToken(t.slice(0, -2) + 'xx', 'secret'), null);
  assert.equal(verifyToken(signToken({ sub: 'x' }, 's', -10), 's'), null);
});

test('Rate limit', () => {
  const rl = createRateLimiter({ limit: 2 });
  assert.equal(rl.hit('a'), true);
  assert.equal(rl.hit('a'), true);
  assert.equal(rl.hit('a'), false);
  assert.equal(rl.hit('b'), true);
  rl.stop();
});

test('E-posta şablonu müşterinin dilinde', () => {
  const m = renderReplyEmail({ lang: 'fi', siteName: 'Spicy Travel Suomi', pageUrl: 'https://spicytravel.fi/x', lines: [{ author: 'Onur', text: 'Hei <b>' }], translated: true });
  assert.match(m.subject, /Spicy Travel Suomi/);
  assert.match(m.text, /Tässä vastauksemme/);
  assert.match(m.html, /Hei &lt;b&gt;/);
});

test('Index tanımları: TTL sadece saklama süresi varsa', () => {
  assert.equal(indexSpecs(0).messages.some((i) => i.expireAfterSeconds), false);
  const ttl = indexSpecs(30).messages.find((i) => i.expireAfterSeconds);
  assert.equal(ttl.expireAfterSeconds, 30 * 86400);
});
