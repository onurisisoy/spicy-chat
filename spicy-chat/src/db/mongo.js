import { MongoClient } from 'mongodb';
import { redactUri } from '../config.js';
import { ensureIndexes } from './indexes.js';

const toApi = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};
const fromApi = ({ id, ...rest }) => ({ _id: id, ...rest });

export function createMongoClient(cfg) {
  return new MongoClient(cfg.mongo.uri, cfg.mongo.options);
}

/**
 * MongoDB deposu. Tüm id'ler string UUID olarak _id alanında tutulur.
 */
export async function createMongoRepo(cfg, log) {
  const client = createMongoClient(cfg);
  log.info(`MongoDB'ye bağlanılıyor: ${redactUri(cfg.mongo.uri)} (db: ${cfg.mongo.dbName})`);
  await client.connect();
  const db = client.db(cfg.mongo.dbName);
  await db.command({ ping: 1 });
  log.info('MongoDB bağlantısı hazır');

  if (cfg.mongo.autoIndex) {
    log.info('MONGODB_AUTO_INDEX=true, index\'ler kontrol ediliyor');
    await ensureIndexes(db, cfg.retentionDays, log);
  }

  const visitors = db.collection('visitors');
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');

  return {
    driver: 'mongo',
    async ping() {
      await db.command({ ping: 1 });
      return true;
    },
    async close() {
      await client.close();
    },

    async getVisitor(id) {
      return toApi(await visitors.findOne({ _id: id }));
    },
    async createVisitor(doc) {
      await visitors.insertOne(fromApi(doc));
      return doc;
    },
    async updateVisitor(id, set) {
      return toApi(await visitors.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' }));
    },

    async findOpenConversation(visitorId) {
      return toApi(await conversations.findOne({ visitorId, status: 'open' }, { sort: { lastMessageAt: -1 } }));
    },
    async findLatestConversation(visitorId) {
      return toApi(await conversations.findOne({ visitorId }, { sort: { lastMessageAt: -1 } }));
    },
    async createConversation(doc) {
      await conversations.insertOne(fromApi(doc));
      return doc;
    },
    async getConversation(id) {
      return toApi(await conversations.findOne({ _id: id }));
    },
    async updateConversation(id, set = {}, inc = null) {
      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (inc) update.$inc = inc;
      return toApi(await conversations.findOneAndUpdate({ _id: id }, update, { returnDocument: 'after' }));
    },
    async findConversationByTopicId(topicId) {
      return toApi(await conversations.findOne({ telegramTopicId: topicId }));
    },
    async listConversations({ status, siteId, limit = 100 } = {}) {
      const q = {};
      if (status && status !== 'all') q.status = status;
      if (siteId) q.siteId = siteId;
      const docs = await conversations.find(q).sort({ lastMessageAt: -1 }).limit(Math.min(limit, 500)).toArray();
      return docs.map(toApi);
    },

    async insertMessage(doc) {
      await messages.insertOne(fromApi(doc));
      return doc;
    },
    async updateMessage(id, set) {
      return toApi(await messages.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' }));
    },
    async listMessages(conversationId, { limit = 100 } = {}) {
      const docs = await messages
        .find({ conversationId })
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 500))
        .toArray();
      return docs.reverse().map(toApi);
    },

    async deleteVisitorData(visitorId) {
      const convIds = (await conversations.find({ visitorId }, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
      const m = await messages.deleteMany({ conversationId: { $in: convIds } });
      const c = await conversations.deleteMany({ visitorId });
      const v = await visitors.deleteOne({ _id: visitorId });
      return { messages: m.deletedCount, conversations: c.deletedCount, visitors: v.deletedCount };
    },
  };
}
