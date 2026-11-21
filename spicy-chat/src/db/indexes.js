/**
 * Index tanımları. Uygulama bunları sadece MONGODB_AUTO_INDEX=true ise açılışta,
 * ya da sen "npm run db:indexes" çalıştırınca oluşturur.
 */
export function indexSpecs(retentionDays = 0) {
  const ttl = retentionDays > 0 ? retentionDays * 24 * 60 * 60 : null;
  const specs = {
    visitors: [
      { key: { siteId: 1, lastSeenAt: -1 }, name: 'site_lastSeen' },
      { key: { email: 1 }, name: 'email', sparse: true },
    ],
    conversations: [
      { key: { visitorId: 1, status: 1, lastMessageAt: -1 }, name: 'visitor_status_last' },
      { key: { status: 1, lastMessageAt: -1 }, name: 'status_last' },
      { key: { siteId: 1, lastMessageAt: -1 }, name: 'site_last' },
      {
        key: { telegramTopicId: 1 },
        name: 'telegramTopic_unique',
        unique: true,
        partialFilterExpression: { telegramTopicId: { $type: 'number' } },
      },
    ],
    messages: [{ key: { conversationId: 1, createdAt: 1 }, name: 'conversation_created' }],
  };
  if (ttl) {
    specs.visitors.push({ key: { lastSeenAt: 1 }, name: 'ttl_lastSeen', expireAfterSeconds: ttl });
    specs.conversations.push({ key: { lastMessageAt: 1 }, name: 'ttl_lastMessage', expireAfterSeconds: ttl });
    specs.messages.push({ key: { createdAt: 1 }, name: 'ttl_created', expireAfterSeconds: ttl });
  }
  return specs;
}

export async function ensureIndexes(db, retentionDays, log = console) {
  const specs = indexSpecs(retentionDays);
  const result = {};
  for (const [coll, list] of Object.entries(specs)) {
    const names = await db.collection(coll).createIndexes(list);
    result[coll] = names;
    log.info(`${coll}: ${names.join(', ')}`);
  }
  return result;
}
