import { EventEmitter } from 'node:events';
import { newId, UUID_RE } from '../util/auth.js';
import { normalizeLang } from '../translate/langs.js';
import { renderReplyEmail } from '../email/templates.js';

export class ChatError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const preview = (s) => String(s).replace(/\s+/g, ' ').slice(0, 140);
const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
const cleanPage = (p = {}) => ({
  url: typeof p.url === 'string' ? p.url.slice(0, 500) : undefined,
  title: typeof p.title === 'string' ? p.title.slice(0, 200) : undefined,
});

/** Müşteriye gösterilecek mesaj biçimi (iç notlar hiç gönderilmez). */
export function toVisitorView(m) {
  if (!m || m.direction === 'note') return null;
  if (m.direction === 'system') {
    if (!['closed', 'ask_email'].includes(m.text)) return null;
    return { id: m.id, dir: 'system', code: m.text, createdAt: m.createdAt };
  }
  const text = m.direction === 'in' ? m.text : m.translation?.ok && m.translation?.text ? m.translation.text : m.text;
  return {
    id: m.id,
    dir: m.direction,
    text,
    author: m.direction === 'out' ? m.author?.name : undefined,
    translated: m.direction === 'out' ? Boolean(m.translation?.translated) : undefined,
    createdAt: m.createdAt,
  };
}

/**
 * Sohbetin çekirdeği. Kanallardan (widget, panel, Telegram) bağımsızdır;
 * her değişikliği "events" üzerinden yayınlar, kanallar dinler.
 *
 * Olaylar:
 *   message       { message, conversation }
 *   conversation  conversation
 *   status        { online, mode }
 */
export function createChatService({ cfg, repo, translator, mailer, presence, log }) {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const sites = new Map(cfg.sites.map((s) => [s.id, s]));
  const agents = new Map(cfg.agents.map((a) => [a.id, a]));
  const teamLangs = cfg.translation.teamLangs;
  const teamTarget = cfg.translation.teamTargetLang;
  let isVisitorConnected = () => false;
  const emailQueue = new Map();

  const now = () => new Date();

  // Aynı ziyaretçinin mesajlarını sırayla işle (hızlı iki mesaj iki konuşma açmasın)
  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  function getSite(siteId) {
    const s = sites.get(siteId);
    if (!s) throw new ChatError('unknown_site', `Bilinmeyen site: ${siteId}`, 404);
    return s;
  }

  async function mustConversation(id) {
    const c = await repo.getConversation(id);
    if (!c) throw new ChatError('not_found', 'Konuşma bulunamadı', 404);
    return c;
  }

  async function saveMessage(conversation, msg, convPatch = {}, inc = null) {
    const message = { id: newId(), conversationId: conversation.id, createdAt: now(), ...msg };
    await repo.insertMessage(message);
    const updated = await repo.updateConversation(conversation.id, { updatedAt: now(), ...convPatch }, inc);
    events.emit('message', { message, conversation: updated });
    events.emit('conversation', updated);
    return { message, conversation: updated };
  }

  // ------------------------------------------------------------------ widget
  async function visitorHello({ siteId, visitorId, lang, page, userAgent }) {
    const site = getSite(siteId);
    let visitor = visitorId && UUID_RE.test(visitorId) ? await repo.getVisitor(visitorId) : null;
    if (visitor && visitor.siteId !== siteId) visitor = null;
    const browserLang = normalizeLang(lang);
    if (!visitor) {
      visitor = await repo.createVisitor({
        id: newId(),
        siteId,
        lang: browserLang || site.defaultLang,
        email: null,
        createdAt: now(),
        lastSeenAt: now(),
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : undefined,
        lastPage: cleanPage(page),
      });
    } else {
      visitor = await repo.updateVisitor(visitor.id, { lastSeenAt: now(), lastPage: cleanPage(page) });
    }
    const conversation = await repo.findLatestConversation(visitor.id);
    const messages = conversation ? (await repo.listMessages(conversation.id, { limit: 50 })).map(toVisitorView).filter(Boolean) : [];
    return {
      visitor,
      site,
      conversation,
      messages,
      online: presence.isOnline(),
      page: cleanPage(page),
    };
  }

  function visitorMessage(args) {
    return withLock(`v:${args.visitorId}`, () => visitorMessageInner(args));
  }

  async function visitorMessageInner({ visitorId, text, page }) {
    const body = clean(text);
    if (!body) throw new ChatError('empty', 'Boş mesaj');
    if (body.length > cfg.limits.maxMessageLength) throw new ChatError('too_long', 'Mesaj çok uzun');
    const visitor = await repo.getVisitor(visitorId);
    if (!visitor) throw new ChatError('unknown_visitor', 'Ziyaretçi bulunamadı', 404);
    const site = getSite(visitor.siteId);
    const sent = cleanPage(page);
    const pg = sent.url ? sent : cleanPage(visitor.lastPage);

    let conversation = await repo.findOpenConversation(visitor.id);
    if (!conversation) {
      conversation = await repo.createConversation({
        id: newId(),
        siteId: site.id,
        visitorId: visitor.id,
        visitorLang: visitor.lang || site.defaultLang,
        visitorEmail: visitor.email || null,
        status: 'open',
        telegramTopicId: null,
        pageUrl: pg.url || null,
        pageTitle: pg.title || null,
        unreadForAgents: 0,
        createdAt: now(),
        updatedAt: now(),
        lastMessageAt: now(),
        lastMessagePreview: '',
      });
      events.emit('conversation', conversation);
    }

    const tr = await translator.translate({ text: body, to: teamTarget, skipIfIn: teamLangs, hintLang: conversation.visitorLang });
    const patch = { lastMessageAt: now(), lastMessagePreview: preview(tr.text), status: 'open' };
    // Kısa mesajlarda ("ok", "tack") dil tespiti güvenilmez; konuşma dilini sadece yeterince uzun metinle değiştir.
    if (tr.detectedLang && body.replace(/\s/g, '').length >= 8 && tr.detectedLang !== conversation.visitorLang) {
      patch.visitorLang = tr.detectedLang;
      await repo.updateVisitor(visitor.id, { lang: tr.detectedLang });
    }
    if (pg.url) {
      patch.pageUrl = pg.url;
      patch.pageTitle = pg.title || null;
    }
    const { message } = await saveMessage(
      conversation,
      {
        direction: 'in',
        author: { type: 'visitor', id: visitor.id },
        text: body,
        lang: tr.detectedLang,
        translation: { text: tr.text, lang: teamTarget, ok: tr.ok, translated: tr.translated, provider: tr.provider, error: tr.error },
        channel: 'widget',
        page: pg.url ? pg : undefined,
      },
      patch,
      { unreadForAgents: 1 },
    );
    await repo.updateVisitor(visitor.id, { lastSeenAt: now() });
    return message;
  }

  async function visitorSetEmail({ visitorId, email }) {
    const value = clean(email).toLowerCase();
    if (!EMAIL_RE.test(value)) throw new ChatError('invalid_email', 'Geçersiz e-posta');
    const visitor = await repo.updateVisitor(visitorId, { email: value });
    if (!visitor) throw new ChatError('unknown_visitor', 'Ziyaretçi bulunamadı', 404);
    const conversation = await repo.findOpenConversation(visitorId) || await repo.findLatestConversation(visitorId);
    if (conversation) {
      await saveMessage(conversation, { direction: 'system', author: { type: 'system' }, text: 'email_set', meta: { email: value }, channel: 'widget' }, { visitorEmail: value });
    }
    return value;
  }

  // ------------------------------------------------------------------ ekip
  function resolveAgent(agentOrId) {
    if (agentOrId && typeof agentOrId === 'object') return agentOrId;
    const a = agents.get(agentOrId);
    if (!a) throw new ChatError('unknown_agent', 'Bilinmeyen ekip üyesi', 403);
    return a;
  }

  async function agentMessage({ conversationId, agent: agentOrId, text, channel, note = false, meta }) {
    const agent = resolveAgent(agentOrId);
    const body = clean(text);
    if (!body) throw new ChatError('empty', 'Boş mesaj');
    if (body.length > 4000) throw new ChatError('too_long', 'Mesaj çok uzun');
    const conversation = await mustConversation(conversationId);
    const author = { type: 'agent', id: agent.id, name: agent.name };

    if (note) {
      const { message } = await saveMessage(conversation, { direction: 'note', author, text: body, lang: null, translation: null, channel, meta });
      return message;
    }

    const to = conversation.visitorLang;
    const tr = await translator.translate({ text: body, to, skipIfIn: [to], hintLang: agent.lang || teamTarget });
    const { message, conversation: updated } = await saveMessage(
      conversation,
      {
        direction: 'out',
        author,
        text: body,
        lang: tr.detectedLang,
        translation: { text: tr.text, lang: to, ok: tr.ok, translated: tr.translated, provider: tr.provider, error: tr.error },
        channel,
        meta,
      },
      { status: 'open', unreadForAgents: 0, lastMessageAt: now(), lastMessagePreview: preview(body) },
    );
    maybeQueueEmail(updated, message);
    return message;
  }

  async function markRead(conversationId) {
    const c = await repo.updateConversation(conversationId, { unreadForAgents: 0 });
    if (c) events.emit('conversation', c);
    return c;
  }

  async function closeConversation({ conversationId, agent: agentOrId, channel }) {
    const agent = resolveAgent(agentOrId);
    const conversation = await mustConversation(conversationId);
    if (conversation.status === 'closed') return conversation;
    const { conversation: updated } = await saveMessage(
      conversation,
      { direction: 'system', author: { type: 'agent', id: agent.id, name: agent.name }, text: 'closed', channel },
      { status: 'closed', closedAt: now(), unreadForAgents: 0 },
    );
    return updated;
  }

  async function requestEmail({ conversationId, agent: agentOrId, channel }) {
    const agent = resolveAgent(agentOrId);
    const conversation = await mustConversation(conversationId);
    await saveMessage(conversation, { direction: 'system', author: { type: 'agent', id: agent.id, name: agent.name }, text: 'ask_email', channel });
  }

  function setStatusMode(mode) {
    presence.setMode(mode);
    const status = { online: presence.isOnline(), mode: presence.mode };
    events.emit('status', status);
    return status;
  }

  function getStatus() {
    return { online: presence.isOnline(), mode: presence.mode };
  }

  async function getConversationDetail(id) {
    const conversation = await mustConversation(id);
    const [visitor, messages] = await Promise.all([repo.getVisitor(conversation.visitorId), repo.listMessages(id, { limit: 200 })]);
    return { conversation, visitor, messages };
  }

  // ------------------------------------------------------------------ e-posta
  function maybeQueueEmail(conversation, message) {
    if (isVisitorConnected(conversation.visitorId)) return;
    const entry = emailQueue.get(conversation.id) || { messages: [], timer: null };
    entry.messages.push(message);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushEmail(conversation.id).catch((e) => log.error(`E-posta gönderilemedi: ${e.message}`)), cfg.email.debounceSeconds * 1000);
    entry.timer.unref?.();
    emailQueue.set(conversation.id, entry);
  }

  async function flushEmail(conversationId) {
    const entry = emailQueue.get(conversationId);
    emailQueue.delete(conversationId);
    if (!entry || !entry.messages.length) return null;
    const conversation = await repo.getConversation(conversationId);
    if (!conversation) return null;
    if (isVisitorConnected(conversation.visitorId)) return null; // müşteri bu arada geri geldi, mesajları canlı gördü
    const visitor = await repo.getVisitor(conversation.visitorId);
    if (!visitor?.email) return null;
    const site = sites.get(conversation.siteId);
    const lines = entry.messages.map((m) => ({ author: m.author?.name || site?.name, text: toVisitorView(m).text }));
    const mail = renderReplyEmail({
      lang: conversation.visitorLang,
      siteName: site?.name || 'Spicy Travel',
      pageUrl: conversation.pageUrl,
      lines,
      translated: entry.messages.some((m) => m.translation?.translated),
    });
    await mailer.send({ to: visitor.email, ...mail });
    await saveMessage(conversation, { direction: 'system', author: { type: 'system' }, text: 'email_sent', meta: { to: visitor.email, count: lines.length }, channel: 'email' });
    return mail;
  }

  async function flushAllEmails() {
    for (const [id, entry] of emailQueue) {
      clearTimeout(entry.timer);
      await flushEmail(id).catch((e) => log.error(`E-posta gönderilemedi: ${e.message}`));
    }
  }

  async function deleteVisitor(visitorId) {
    return repo.deleteVisitorData(visitorId);
  }

  return {
    events,
    getSite,
    agents: [...agents.values()],
    setVisitorPresenceCheck(fn) {
      isVisitorConnected = fn;
    },
    visitorHello,
    visitorMessage,
    visitorSetEmail,
    agentMessage,
    markRead,
    closeConversation,
    requestEmail,
    setStatusMode,
    getStatus,
    listConversations: (filter) => repo.listConversations(filter),
    getConversationDetail,
    getConversation: (id) => repo.getConversation(id),
    findConversationByTopicId: (id) => repo.findConversationByTopicId(id),
    setTelegramTopic: async (id, set) => {
      const c = await repo.updateConversation(id, set);
      if (c) events.emit('conversation', c);
      return c;
    },
    flushEmail,
    flushAllEmails,
    deleteVisitor,
  };
}
