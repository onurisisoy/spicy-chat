/**
 * MongoDB deposunun gerçek bir MongoDB'ye karşı testi. Otomatik testlerde ÇALIŞMAZ.
 *
 *   MONGODB_TEST_URI="mongodb://kullanici:sifre@127.0.0.1:27017/?authSource=admin" npm run test:mongo
 *
 * Rastgele adlı geçici bir veritabanı açar (spicychat_test_xxxx), işi bitince SADECE onu siler.
 * Kullanıcının o veritabanını oluşturma/silme yetkisi olmalı (örn. readWriteAnyDatabase ya da dbOwner).
 * Canlı "spicychat" veritabanına dokunmaz.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createMongoRepo } from '../src/db/mongo.js';
import { ensureIndexes } from '../src/db/indexes.js';

const uri = process.env.MONGODB_TEST_URI;
const dbName = `spicychat_test_${crypto.randomBytes(3).toString('hex')}`;
const silent = { info() {}, warn() {}, error() {}, debug() {} };
let repo;

before(async () => {
  if (!uri) return;
  repo = await createMongoRepo({ mongo: { uri, dbName, options: { serverSelectionTimeoutMS: 5000 }, autoIndex: false }, retentionDays: 0 }, silent);
});

after(async () => {
  if (!uri) return;
  await repo?.close();
  const c = new MongoClient(uri);
  await c.connect();
  if (dbName.startsWith('spicychat_test_')) await c.db(dbName).dropDatabase();
  await c.close();
});

test('MongoDB deposu', { skip: !uri && 'MONGODB_TEST_URI tanımlı değil' }, async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const names = await ensureIndexes(client.db(dbName), 30, silent);
  assert.ok(names.messages.includes('ttl_created'));
  assert.ok(names.conversations.includes('telegramTopic_unique'));
  await client.close();

  const id = () => crypto.randomUUID();
  const t0 = new Date();
  const v = await repo.createVisitor({ id: id(), siteId: 's', lang: 'sv', email: null, createdAt: t0, lastSeenAt: t0 });
  assert.equal((await repo.getVisitor(v.id)).lang, 'sv');
  assert.equal((await repo.updateVisitor(v.id, { email: 'a@b.se' })).email, 'a@b.se');

  const c1 = await repo.createConversation({ id: id(), siteId: 's', visitorId: v.id, status: 'open', telegramTopicId: null, unreadForAgents: 0, lastMessageAt: t0 });
  const c2 = await repo.createConversation({ id: id(), siteId: 's', visitorId: v.id, status: 'closed', telegramTopicId: null, unreadForAgents: 0, lastMessageAt: new Date(t0.getTime() - 1000) });
  assert.equal((await repo.findOpenConversation(v.id)).id, c1.id);
  assert.equal((await repo.findLatestConversation(v.id)).id, c1.id);
  const up = await repo.updateConversation(c1.id, { telegramTopicId: 55 }, { unreadForAgents: 2 });
  assert.equal(up.unreadForAgents, 2);
  assert.equal((await repo.findConversationByTopicId(55)).id, c1.id);
  // null topic id'li iki konuşma unique index'e takılmamalı
  assert.equal((await repo.getConversation(c2.id)).telegramTopicId, null);
  await assert.rejects(repo.updateConversation(c2.id, { telegramTopicId: 55 }), /duplicate key/);

  for (let i = 0; i < 3; i++) {
    await repo.insertMessage({ id: id(), conversationId: c1.id, direction: 'in', text: `m${i}`, createdAt: new Date(t0.getTime() + i) });
  }
  const msgs = await repo.listMessages(c1.id, { limit: 2 });
  assert.deepEqual(msgs.map((m) => m.text), ['m1', 'm2']);
  assert.equal((await repo.listConversations({ status: 'open' })).length, 1);
  assert.equal((await repo.listConversations({ status: 'all' })).length, 2);

  assert.deepEqual(await repo.deleteVisitorData(v.id), { messages: 3, conversations: 2, visitors: 1 });
  assert.equal(await repo.getVisitor(v.id), null);
});
