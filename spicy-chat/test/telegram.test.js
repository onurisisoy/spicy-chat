import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { testConfig, wsClient, waitFor, fakeTelegram } from './helpers.js';

const GROUP = -1001234567890;
const ORIGIN = { origin: 'http://localhost:3000' };
let tg;
let app;
let wsBase;

before(async () => {
  tg = fakeTelegram();
  const apiBase = await tg.start();
  const { cfg } = testConfig({
    TELEGRAM_BOT_TOKEN: '123:test',
    TELEGRAM_GROUP_ID: String(GROUP),
    TELEGRAM_API_BASE: apiBase,
    TELEGRAM_ALLOW_ALL_GROUP_MEMBERS: 'true',
  });
  app = await startServer(cfg, { port: 0 });
  wsBase = `ws://127.0.0.1:${app.port}`;
});

after(async () => {
  await app.close();
  await tg.close();
});

const sent = () => tg.calls.filter((c) => c.method === 'sendMessage');

test('Telegram: topic açılır, müşteri mesajı çeviriyle düşer, topic\'ten cevap müşteriye gider', async () => {
  const visitor = await wsClient(`${wsBase}/ws/visitor?site=spicytravel-dk`, ORIGIN);
  visitor.send({ t: 'hello', page: { url: 'https://spicytravel.dk/side', title: 'Side' } });
  await visitor.next((m) => m.t === 'welcome');

  // İki mesajı hızlıca gönder: tek topic açılmalı
  visitor.send({ t: 'msg', cid: 'a', text: 'Hej! Er der ledige pladser i Side? Jeg vil gerne have to værelser.' });
  visitor.send({ t: 'msg', cid: 'b', text: 'Og hvad koster det?' });
  await visitor.next((m) => m.t === 'ack' && m.cid === 'b');
  await waitFor(() => sent().length >= 3); // başlık + 2 mesaj
  await app.bot.idle();

  const topics = tg.calls.filter((c) => c.method === 'createForumTopic');
  assert.equal(topics.length, 1, 'aynı konuşma için tek topic');
  assert.match(topics[0].params.name, /^\[DA\] spicytravel\.dk · #[0-9A-F]{4}$/);
  const threadId = 101;
  assert.ok(sent().every((c) => c.params.message_thread_id === threadId && c.params.chat_id === GROUP));
  assert.match(sent()[0].params.text, /Yeni konuşma/);
  assert.match(sent()[0].params.text, /spicytravel\.dk\/side/);
  assert.match(sent()[1].params.text, /\[da→tr\] Hej! Er der ledige pladser i Side\?/);
  assert.match(sent()[1].params.text, /<i>Hej! Er der/); // orijinal metin de var

  // --- Ekip topic'e yazar
  tg.push({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 42, first_name: 'Ayşe' }, message_thread_id: threadId, is_topic_message: true, text: 'Merhaba, evet yer var. Teşekkürler!' });
  const reply = await visitor.next((m) => m.t === 'msg' && m.m.dir === 'out', 5000);
  assert.equal(reply.m.text, '[tr→da] Merhaba, evet yer var. Teşekkürler!');
  assert.equal(reply.m.author, 'Ayşe');
  // Bot, müşterinin ne gördüğünü topic'e yazar
  await waitFor(() => sent().some((c) => c.params.text.startsWith('↳')));
  const echo = sent().find((c) => c.params.text.startsWith('↳'));
  assert.match(echo.params.text, /da: \[tr→da\]/);
  assert.ok(echo.params.reply_parameters?.message_id);

  // --- iç not müşteriye gitmez
  visitor.drain();
  tg.push({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 42, first_name: 'Ayşe' }, message_thread_id: threadId, is_topic_message: true, text: '#not fiyatı yarın teyit et' });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(visitor.drain(), [], 'iç not müşteriye gitmemeli');

  // --- /eposta ve /kapat
  tg.push({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 42, first_name: 'Ayşe' }, message_thread_id: threadId, is_topic_message: true, text: '/eposta@spicy_test_bot' });
  assert.equal((await visitor.next((m) => m.t === 'msg' && m.m.dir === 'system', 5000)).m.code, 'ask_email');
  tg.push({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 42, first_name: 'Ayşe' }, message_thread_id: threadId, is_topic_message: true, text: '/kapat' });
  assert.equal((await visitor.next((m) => m.t === 'msg' && m.m.code === 'closed', 5000)).m.code, 'closed');
  await waitFor(() => tg.calls.some((c) => c.method === 'closeForumTopic' && c.params.message_thread_id === threadId));

  // --- /offline genel sohbetten durum değiştirir
  tg.push({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 42, first_name: 'Ayşe' }, text: '/offline' });
  assert.equal((await visitor.next((m) => m.t === 'status', 5000)).online, false);

  // --- panelden yazılan cevap topic'e de düşer
  const { body: login } = await fetch(`http://127.0.0.1:${app.port}/api/panel/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'onur', password: 'test-pass' }),
  }).then(async (r) => ({ body: await r.json() }));
  const list = await fetch(`http://127.0.0.1:${app.port}/api/panel/conversations?status=all`, { headers: { authorization: `Bearer ${login.token}` } }).then((r) => r.json());
  await fetch(`http://127.0.0.1:${app.port}/api/panel/conversations/${list[0].id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ text: 'Fiyat kişi başı 899 EUR.' }),
  });
  await waitFor(() => sent().some((c) => /<b>Onur<\/b> <i>\(panel\)<\/i>/.test(c.params.text)));
  // kapalı topic yeniden açıldı
  assert.ok(tg.calls.some((c) => c.method === 'reopenForumTopic'));

  await visitor.close();
});

test('Telegram: yetkisiz kullanıcı ve başka gruptan gelen mesajlar yok sayılır', async () => {
  const count = sent().length;
  tg.push({ chat: { id: -100999, type: 'supergroup' }, from: { id: 7, first_name: 'X' }, message_thread_id: 101, is_topic_message: true, text: 'merhaba' });
  tg.push({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 8, first_name: 'Bot', is_bot: true }, message_thread_id: 101, is_topic_message: true, text: 'spam' });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent().length, count);
});
