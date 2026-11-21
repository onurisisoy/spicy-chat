#!/usr/bin/env node
/**
 * Telegram kurulumunu kontrol eder.
 *   npm run telegram:check
 * TELEGRAM_GROUP_ID boşsa, bota son yazılan sohbetleri listeler ki grup id'sini bulasın.
 * Not: Uygulama çalışırken bunu çalıştırma (ikisi aynı anda getUpdates yapamaz).
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { createTelegramApi } from '../src/telegram/api.js';

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });
const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const groupId = (process.env.TELEGRAM_GROUP_ID || '').trim();
const apiBase = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);

if (!token) {
  console.log('\nTELEGRAM_BOT_TOKEN boş. @BotFather ile bot oluştur ve token\'ı .env\'e yaz.\n');
  process.exit(1);
}
const tg = createTelegramApi({ token, apiBase });

try {
  const me = await tg('getMe');
  ok(`Bot: @${me.username} (id ${me.id})`);
  if (me.can_read_all_group_messages) ok('Privacy mode kapalı (bot tüm grup mesajlarını görür)');
  else console.log('  ! Privacy mode açık. Bot grupta admin olursa sorun değil; değilse BotFather → /setprivacy → Disable');

  const hook = await tg('getWebhookInfo');
  if (hook.url) {
    bad(`Webhook kurulu (${hook.url}). Long polling bununla çalışmaz; tarayıcıda şunu aç: https://api.telegram.org/bot<TOKEN>/deleteWebhook`);
  }

  if (!groupId) {
    console.log('\nTELEGRAM_GROUP_ID boş. Botu gruba ekle, grupta /chatid yaz ya da herhangi bir mesaj at, sonra bunu tekrar çalıştır.');
    const updates = await tg('getUpdates', { timeout: 0, allowed_updates: ['message'] });
    const chats = new Map();
    for (const u of updates) if (u.message?.chat) chats.set(u.message.chat.id, u.message.chat);
    if (!chats.size) console.log('  (henüz mesaj yok)');
    for (const c of chats.values()) console.log(`  → ${c.title || c.username || c.first_name}  id: ${c.id}  tür: ${c.type}${c.is_forum ? ' (forum)' : ''}`);
    console.log('');
    process.exit(0);
  }

  const chat = await tg('getChat', { chat_id: Number(groupId) });
  ok(`Grup: ${chat.title} (${chat.type})`);
  if (chat.is_forum) ok('Topics (forum) açık');
  else bad('Topics kapalı → Grup ayarları → Topics\'i aç');

  const member = await tg('getChatMember', { chat_id: Number(groupId), user_id: me.id });
  if (member.status === 'administrator') ok('Bot grupta admin');
  else bad(`Bot admin değil (durum: ${member.status}) → botu admin yap`);
  if (member.can_manage_topics) ok('"Manage Topics" yetkisi var');
  else bad('"Manage Topics" yetkisi yok → admin ayarlarından aç');
  console.log('');
} catch (e) {
  bad(e.message);
  if (/409/.test(e.message)) console.log('  Uygulama şu an çalışıyor olabilir; önce durdur.');
  process.exit(1);
}
