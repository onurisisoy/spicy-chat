/**
 * Bellek içi depo: MongoDB olmadan hızlı deneme ve testler için.
 * Uygulama yeniden başlayınca her şey silinir.
 */
const clone = (x) => (x == null ? null : structuredClone(x));

export function createMemoryRepo(log) {
  log?.warn?.('DB_DRIVER=memory: veriler bellekte, yeniden başlatınca silinir');
  const visitors = new Map();
  const conversations = new Map();
  const messages = new Map();
  const byLastDesc = (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt);

  return {
    driver: 'memory',
    async ping() {
      return true;
    },
    async close() {},

    async getVisitor(id) {
      return clone(visitors.get(id));
    },
    async createVisitor(doc) {
      visitors.set(doc.id, clone(doc));
      return clone(doc);
    },
    async updateVisitor(id, set) {
      const v = visitors.get(id);
      if (!v) return null;
      Object.assign(v, clone(set));
      return clone(v);
    },

    async findOpenConversation(visitorId) {
      return clone([...conversations.values()].filter((c) => c.visitorId === visitorId && c.status === 'open').sort(byLastDesc)[0]);
    },
    async findLatestConversation(visitorId) {
      return clone([...conversations.values()].filter((c) => c.visitorId === visitorId).sort(byLastDesc)[0]);
    },
    async createConversation(doc) {
      conversations.set(doc.id, clone(doc));
      return clone(doc);
    },
    async getConversation(id) {
      return clone(conversations.get(id));
    },
    async updateConversation(id, set = {}, inc = null) {
      const c = conversations.get(id);
      if (!c) return null;
      Object.assign(c, clone(set));
      if (inc) for (const [k, n] of Object.entries(inc)) c[k] = (c[k] || 0) + n;
      return clone(c);
    },
    async findConversationByTopicId(topicId) {
      return clone([...conversations.values()].find((c) => c.telegramTopicId === topicId));
    },
    async listConversations({ status, siteId, limit = 100 } = {}) {
      return [...conversations.values()]
        .filter((c) => (!status || status === 'all' || c.status === status) && (!siteId || c.siteId === siteId))
        .sort(byLastDesc)
        .slice(0, limit)
        .map(clone);
    },

    async insertMessage(doc) {
      messages.set(doc.id, clone(doc));
      return clone(doc);
    },
    async updateMessage(id, set) {
      const m = messages.get(id);
      if (!m) return null;
      Object.assign(m, clone(set));
      return clone(m);
    },
    async listMessages(conversationId, { limit = 100 } = {}) {
      return [...messages.values()]
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(-limit)
        .map(clone);
    },

    async deleteVisitorData(visitorId) {
      const convIds = [...conversations.values()].filter((c) => c.visitorId === visitorId).map((c) => c.id);
      let m = 0;
      for (const [id, msg] of messages) if (convIds.includes(msg.conversationId)) { messages.delete(id); m++; }
      for (const id of convIds) conversations.delete(id);
      const v = visitors.delete(visitorId) ? 1 : 0;
      return { messages: m, conversations: convIds.length, visitors: v };
    },
  };
}
