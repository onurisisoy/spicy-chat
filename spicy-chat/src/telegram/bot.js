import { createTelegramApi, escapeHtml as h, TelegramError } from './api.js';
import { ChatError } from '../chat/service.js';
import { shortId } from '../util/auth.js';

const HELP = [
  '<b>Komutlar</b>',
  'Bir konuşma topic\'inde:',
  '• Düz yaz → müşteriye kendi dilinde gider',
  '• <code>#not metin</code> → sadece ekip görür',
  '• /eposta → müşteriden e-posta iste',
  '• /kapat → konuşmayı kapat',
  'Her yerde:',
  '• /online, /offline, /otomatik → durum',
  '• /durum → şu anki durum',
  '• /chatid → bu sohbetin id\'si',
].join('\n');

const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i;
const TOPIC_CLOSED = /TOPIC_CLOSED/i;

/**
 * Telegram köprüsü: her konuşma, forum grubunda bir topic.
 * Long polling kullanır (lokal testte webhook/HTTPS gerekmez).
 */
export function createTelegramBot({ cfg, service, log }) {
  const tg = createTelegramApi(cfg.telegram);
  const groupId = Number(cfg.telegram.groupId);
  const chains = new Map();
  let me = null;
  let offset = 0;
  let running = false;
  let abort = null;
  let loopPromise = null;

  /** Aynı konuşmaya ait Telegram işlemlerini sırayla yürüt (çift topic açılmasın). */
  const serial = (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => log.error(`Telegram: ${e.message}`));
    chains.set(key, next);
    next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };

  const findAgent = (from) => {
    const a = cfg.agents.find((x) => x.telegramUserId && Number(x.telegramUserId) === Number(from.id));
    if (a) return a;
    if (!cfg.telegram.allowAllGroupMembers) return null;
    return { id: `tg:${from.id}`, name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Ekip', lang: 'tr' };
  };

  const siteOf = (c) => cfg.sites.find((s) => s.id === c.siteId);

  async function createTopic(conversation) {
    const site = siteOf(conversation);
    const name = `[${String(conversation.visitorLang || '?').toUpperCase()}] ${site?.domain || conversation.siteId} · #${shortId(conversation.visitorId)}`;
    const topic = await tg('createForumTopic', { chat_id: groupId, name: name.slice(0, 128) });
    const updated = await service.setTelegramTopic(conversation.id, { telegramTopicId: topic.message_thread_id, telegramTopicClosed: false });
    const lines = [
      `<b>Yeni konuşma</b> · ${h(site?.name || conversation.siteId)}`,
      `Dil: <b>${h(conversation.visitorLang)}</b> · Ziyaretçi #${h(shortId(conversation.visitorId))}`,
      conversation.pageUrl ? `Sayfa: ${h(conversation.pageTitle || '')}\n${h(conversation.pageUrl)}` : '',
      '',
      'Buraya yazdığın her şey müşteriye kendi dilinde gider. <code>#not</code> ile başlayan mesajlar gitmez. /yardim',
    ].filter((x) => x !== '');
    await tg('sendMessage', { chat_id: groupId, message_thread_id: topic.message_thread_id, text: lines.join('\n'), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    log.info(`Telegram topic açıldı: ${name}`);
    return updated;
  }

  async function sendToTopic(conversation, text, extra = {}) {
    let conv = conversation;
    if (!conv.telegramTopicId) conv = await createTopic(conv);
    if (conv.telegramTopicClosed && conv.status === 'open') {
      await tg('reopenForumTopic', { chat_id: groupId, message_thread_id: conv.telegramTopicId }).catch(() => {});
      conv = await service.setTelegramTopic(conv.id, { telegramTopicClosed: false });
    }
    const params = { chat_id: groupId, message_thread_id: conv.telegramTopicId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
    try {
      return await tg('sendMessage', params);
    } catch (e) {
      if (e instanceof TelegramError && TOPIC_CLOSED.test(e.description)) {
        await tg('reopenForumTopic', { chat_id: groupId, message_thread_id: conv.telegramTopicId });
        await service.setTelegramTopic(conv.id, { telegramTopicClosed: false });
        return tg('sendMessage', params);
      }
      if (e instanceof TelegramError && TOPIC_GONE.test(e.description)) {
        log.warn('Topic silinmiş/kapalı, yenisi açılıyor');
        conv = await createTopic({ ...conv, telegramTopicId: null });
        delete params.reply_parameters;
        return tg('sendMessage', { ...params, message_thread_id: conv.telegramTopicId });
      }
      throw e;
    }
  }

  // ---------------------------------------------------------- servis → Telegram
  function onMessage({ message: m, conversation: c }) {
    const fromTelegram = m.channel === 'telegram';
    serial(c.id, async () => {
      // Konuşmanın güncel halini al (topic id başka bir işlemle yazılmış olabilir)
      const conv = (await service.getConversation(c.id).catch(() => null)) || c;
      if (m.direction === 'in') {
        const t = m.translation;
        const lines = [`<b>Müşteri</b> <i>(${h(m.lang || '?')})</i>`];
        if (t?.translated) {
          lines.push(h(t.text), '', `<i>${h(m.text)}</i>`);
        } else {
          lines.push(h(m.text));
          if (t && !t.ok) lines.push('<i>(çevrilemedi, orijinal metin)</i>');
        }
        await sendToTopic(conv, lines.join('\n'));
        return;
      }
      if (m.direction === 'out') {
        const t = m.translation;
        const sent = t?.translated ? `↳ <i>${h(t.lang)}: ${h(t.text)}</i>` : t && !t.ok ? '↳ <i>(çevrilemedi, müşteriye orijinal gitti)</i>' : '';
        if (fromTelegram) {
          if (sent) {
            await sendToTopic(conv, sent, {
              disable_notification: true,
              reply_parameters: m.meta?.telegramMessageId ? { message_id: m.meta.telegramMessageId, allow_sending_without_reply: true } : undefined,
            });
          }
          return;
        }
        await sendToTopic(conv, [`<b>${h(m.author?.name)}</b> <i>(panel)</i>`, h(m.text), sent].filter(Boolean).join('\n'));
        return;
      }
      if (m.direction === 'note') {
        if (!fromTelegram) await sendToTopic(conv, `📝 <b>Not · ${h(m.author?.name)}</b>\n${h(m.text)}`);
        return;
      }
      if (m.direction === 'system') {
        const by = m.author?.name ? ` (${h(m.author.name)})` : '';
        if (m.text === 'closed') {
          if (!conv.telegramTopicId) return;
          await sendToTopic(conv, `Konuşma kapatıldı${by}.`, { disable_notification: true });
          await tg('closeForumTopic', { chat_id: groupId, message_thread_id: conv.telegramTopicId }).catch(() => {});
          await service.setTelegramTopic(conv.id, { telegramTopicClosed: true });
        } else if (m.text === 'ask_email') {
          if (conv.telegramTopicId) await sendToTopic(conv, `Müşteriden e-posta istendi${by}.`, { disable_notification: true });
        } else if (m.text === 'email_set') {
          await sendToTopic(conv, `Müşteri e-posta bıraktı: <code>${h(m.meta?.email)}</code>`, { disable_notification: true });
        } else if (m.text === 'email_sent') {
          await sendToTopic(conv, `Müşteri çevrimdışı, cevap e-postayla gönderildi → ${h(m.meta?.to)}`, { disable_notification: true });
        }
      }
    });
  }

  // ---------------------------------------------------------- Telegram → servis
  const reply = (msg, text, extra = {}) =>
    tg('sendMessage', {
      chat_id: msg.chat.id,
      message_thread_id: msg.is_topic_message ? msg.message_thread_id : undefined,
      text,
      parse_mode: 'HTML',
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...extra,
    }).catch((e) => log.warn(`Telegram cevap yazılamadı: ${e.message}`));

  async function handleMessage(msg) {
    if (!msg || msg.from?.is_bot) return;
    const text = (msg.text || msg.caption || '').trim();
    const cmdMatch = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
    if (cmdMatch && cmdMatch[2] && me && cmdMatch[2].toLowerCase() !== me.username.toLowerCase()) return; // başka bota
    const cmd = cmdMatch ? cmdMatch[1].toLowerCase() : null;

    if (cmd === 'chatid') return reply(msg, `Bu sohbetin id'si: <code>${msg.chat.id}</code>${msg.is_topic_message ? `\nTopic id: <code>${msg.message_thread_id}</code>` : ''}`);
    if (Number(msg.chat.id) !== groupId) return;

    const agent = findAgent(msg.from);
    if (!agent) {
      if (text) await reply(msg, 'Bu botu kullanma yetkin yok. config/agents.json içine telegramUserId eklenmeli: <code>' + msg.from.id + '</code>');
      return;
    }

    if (cmd === 'yardim' || cmd === 'help' || cmd === 'start') return reply(msg, HELP);
    if (cmd === 'online' || cmd === 'offline' || cmd === 'otomatik') {
      const s = service.setStatusMode(cmd === 'otomatik' ? 'auto' : cmd);
      return reply(msg, `Durum: <b>${s.mode === 'auto' ? 'otomatik (çalışma saatleri)' : s.mode}</b> · şu an ${s.online ? 'online' : 'offline'}`);
    }
    if (cmd === 'durum') {
      const s = service.getStatus();
      return reply(msg, `Durum: <b>${s.mode === 'auto' ? 'otomatik' : s.mode}</b> · şu an ${s.online ? 'online' : 'offline'}`);
    }

    if (!msg.is_topic_message || !msg.message_thread_id) return; // General'daki sohbet
    const conversation = await service.findConversationByTopicId(msg.message_thread_id);
    if (!conversation) return reply(msg, 'Bu topic bir müşteri konuşmasına bağlı değil.');

    try {
      if (cmd === 'kapat') {
        await service.closeConversation({ conversationId: conversation.id, agent, channel: 'telegram' });
        return;
      }
      if (cmd === 'eposta') {
        await service.requestEmail({ conversationId: conversation.id, agent, channel: 'telegram' });
        return;
      }
      if (cmd) return reply(msg, 'Bilinmeyen komut. /yardim');
      if (!msg.text) return reply(msg, 'Şimdilik sadece metin mesajları destekleniyor.');
      if (/^#not\b/i.test(text)) {
        const body = text.replace(/^#not\b[:\s]*/i, '');
        if (body) await service.agentMessage({ conversationId: conversation.id, agent, text: body, channel: 'telegram', note: true, meta: { telegramMessageId: msg.message_id } });
        return;
      }
      await service.agentMessage({ conversationId: conversation.id, agent, text, channel: 'telegram', meta: { telegramMessageId: msg.message_id } });
    } catch (e) {
      if (e instanceof ChatError) return reply(msg, `Gönderilemedi: ${h(e.message)}`);
      throw e;
    }
  }

  async function loop() {
    let backoff = 1000;
    while (running) {
      try {
        abort = new AbortController();
        const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, { signal: abort.signal });
        backoff = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleMessage(u.message).catch((e) => log.error(`Telegram mesajı işlenemedi: ${e.stack || e.message}`));
        }
      } catch (e) {
        if (!running) break;
        if (e instanceof TelegramError && e.code === 409) {
          log.error('Telegram 409: bu bot token\'ı ile başka bir yerde getUpdates/webhook çalışıyor. Diğerini kapat ya da deleteWebhook çağır.');
        } else {
          log.warn(`Telegram bağlantı hatası: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  return {
    async start() {
      me = await tg('getMe');
      log.info(`Telegram botu: @${me.username} · grup ${groupId}`);
      try {
        const chat = await tg('getChat', { chat_id: groupId });
        if (!chat.is_forum) log.warn('Telegram grubunda Topics (forum) kapalı. Grup ayarlarından Topics\'i aç.');
        const member = await tg('getChatMember', { chat_id: groupId, user_id: me.id });
        if (member.status !== 'administrator' || !member.can_manage_topics) {
          log.warn('Bot grupta "Manage Topics" yetkili admin değil. Topic açamaz.');
        }
      } catch (e) {
        log.warn(`Telegram grup kontrolü yapılamadı: ${e.message}`);
      }
      service.events.on('message', onMessage);
      running = true;
      loopPromise = loop();
    },
    async stop() {
      running = false;
      service.events.off('message', onMessage);
      abort?.abort();
      await loopPromise?.catch(() => {});
      await Promise.allSettled([...chains.values()]);
    },
    /** testler için */
    handleMessage,
    idle: () => Promise.allSettled([...chains.values()]),
  };
}
