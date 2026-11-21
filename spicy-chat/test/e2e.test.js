import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../src/server.js';
import { testConfig, wsClient, json, waitFor } from './helpers.js';

const ORIGIN = { origin: 'http://localhost:3000' };
let app;
let base;
let wsBase;
let outbox;
let token;

before(async () => {
  const t = testConfig();
  outbox = t.outbox;
  app = await startServer(t.cfg, { port: 0 });
  base = `http://127.0.0.1:${app.port}`;
  wsBase = `ws://127.0.0.1:${app.port}`;
  const login = await json(base, 'POST', '/api/panel/login', { agentId: 'onur', password: 'test-pass' });
  token = login.body.token;
});

after(async () => {
  await app.close();
});

test('statik dosyalar ve sağlık kontrolü', async () => {
  const h = await json(base, 'GET', '/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.dbDriver, 'memory');
  const w = await fetch(`${base}/widget.js`);
  assert.equal(w.status, 200);
  assert.match(await w.text(), /Spicy Chat widget/);
  assert.equal((await fetch(`${base}/panel/`)).status, 200);
  assert.equal((await fetch(`${base}/test/se.html`)).status, 200);
  const c = await fetch(`${base}/api/widget/config?site=spicytravel-se`, { headers: ORIGIN });
  assert.equal(c.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal((await c.json()).site.defaultLang, 'sv');
});

test('panel girişi: yanlış şifre reddedilir, korumalı uçlar token ister', async () => {
  const bad = await json(base, 'POST', '/api/panel/login', { agentId: 'onur', password: 'yanlis' });
  assert.equal(bad.status, 401);
  assert.equal((await json(base, 'GET', '/api/panel/conversations')).status, 401);
  await assert.rejects(wsClient(`${wsBase}/ws/agent?token=sahte`), /401/);
});

test('izinsiz origin ve bilinmeyen site reddedilir', async () => {
  await assert.rejects(wsClient(`${wsBase}/ws/visitor?site=spicytravel-se`, { origin: 'https://kotu-site.com' }), /403/);
  await assert.rejects(wsClient(`${wsBase}/ws/visitor?site=yok`, ORIGIN), /404/);
});

test('uçtan uca: müşteri İsveççe yazar, ekip Türkçe cevaplar, not/e-posta/kapatma', async () => {
  const agent = await wsClient(`${wsBase}/ws/agent?token=${encodeURIComponent(token)}`);
  const hello = await agent.next((m) => m.t === 'hello');
  assert.equal(hello.agent.name, 'Onur');

  // --- müşteri bağlanır
  let visitor = await wsClient(`${wsBase}/ws/visitor?site=spicytravel-se`, ORIGIN);
  visitor.send({ t: 'hello', lang: 'sv-SE', page: { url: 'https://spicytravel.se/alanya', title: 'Alanya' } });
  const welcome = await visitor.next((m) => m.t === 'welcome');
  assert.match(welcome.vid, /^[0-9a-f-]{36}$/);
  assert.equal(welcome.online, true);
  assert.deepEqual(welcome.messages, []);
  const vid = welcome.vid;

  // --- müşteri yazar → ekip Türkçe görür
  visitor.send({ t: 'msg', cid: 'c1', text: 'Hej! Finns det plats den 12 maj för två vuxna?', page: { url: 'https://spicytravel.se/alanya', title: 'Alanya' } });
  const ack = await visitor.next((m) => m.t === 'ack' && m.cid === 'c1');
  assert.equal(ack.m.dir, 'in');
  const inbound = await agent.next((m) => m.t === 'msg' && m.m.direction === 'in');
  assert.equal(inbound.m.lang, 'sv');
  assert.equal(inbound.m.translation.text, '[sv→tr] Hej! Finns det plats den 12 maj för två vuxna?');
  assert.equal(inbound.c.visitorLang, 'sv');
  assert.equal(inbound.c.unreadForAgents, 1);
  assert.equal(inbound.c.pageUrl, 'https://spicytravel.se/alanya');
  const convId = inbound.c.id;

  // --- liste ve detay
  const list = await json(base, 'GET', '/api/panel/conversations?status=open', null, token);
  assert.equal(list.body.length, 1);
  const read = await json(base, 'POST', `/api/panel/conversations/${convId}/read`, {}, token);
  assert.equal(read.body.unreadForAgents, 0);

  // --- ekip iç not yazar → müşteri GÖRMEZ
  const note = await json(base, 'POST', `/api/panel/conversations/${convId}/messages`, { text: 'Müsaitliği kontrol ediyorum', note: true }, token);
  assert.equal(note.status, 201);
  assert.equal(note.body.direction, 'note');

  // --- ekip cevap yazar → müşteri İsveççe görür
  const out = await json(base, 'POST', `/api/panel/conversations/${convId}/messages`, { text: 'Merhaba, evet yer var. Teşekkürler!' }, token);
  assert.equal(out.body.translation.lang, 'sv');
  const reply = await visitor.next((m) => m.t === 'msg');
  assert.equal(reply.m.dir, 'out', 'not müşteriye gitmemeli; ilk gelen mesaj cevap olmalı');
  assert.equal(reply.m.text, '[tr→sv] Merhaba, evet yer var. Teşekkürler!');
  assert.equal(reply.m.author, 'Onur');

  // --- e-posta iste → müşteri formu görür, e-posta bırakır
  await json(base, 'POST', `/api/panel/conversations/${convId}/ask-email`, {}, token);
  const ask = await visitor.next((m) => m.t === 'msg' && m.m.dir === 'system');
  assert.equal(ask.m.code, 'ask_email');
  visitor.send({ t: 'email', email: 'kalle@exempel' });
  assert.equal((await visitor.next((m) => m.t === 'error')).code, 'invalid_email');
  visitor.send({ t: 'email', email: 'Kalle@Exempel.se' });
  assert.equal((await visitor.next((m) => m.t === 'email_ok')).email, 'kalle@exempel.se');
  const emailSet = await agent.next((m) => m.t === 'msg' && m.m.text === 'email_set');
  assert.equal(emailSet.c.visitorEmail, 'kalle@exempel.se');

  // --- müşteri sayfayı kapatır → cevap e-postayla gider
  await visitor.close();
  await waitFor(() => app.hub.stats().visitors === 0);
  await json(base, 'POST', `/api/panel/conversations/${convId}/messages`, { text: 'Rezervasyon numaranız SPT-12345. İyi tatiller!' }, token);
  const sent = await agent.next((m) => m.t === 'msg' && m.m.text === 'email_sent');
  assert.equal(sent.m.meta.to, 'kalle@exempel.se');
  const files = fs.readdirSync(outbox);
  assert.equal(files.length, 1);
  const eml = fs.readFileSync(`${outbox}/${files[0]}`, 'utf8');
  assert.match(eml, /To: kalle@exempel\.se/);
  assert.match(eml, /Subject: Svar fr=C3=A5n Spicy Travel Sverige|Subject: =\?UTF-8\?Q\?Svar_fr=C3=A5n/);

  // --- müşteri geri döner → geçmişi görür (not hariç)
  visitor = await wsClient(`${wsBase}/ws/visitor?site=spicytravel-se`, ORIGIN);
  visitor.send({ t: 'hello', vid });
  const back = await visitor.next((m) => m.t === 'welcome');
  assert.equal(back.vid, vid);
  assert.equal(back.emailKnown, true);
  const dirs = back.messages.map((m) => m.dir + (m.code ? `:${m.code}` : ''));
  assert.deepEqual(dirs, ['in', 'out', 'system:ask_email', 'out']);
  assert.ok(!back.messages.some((m) => /Müsaitliği/.test(m.text || '')), 'iç not müşteriye sızmamalı');

  // --- kapat
  const closed = await json(base, 'POST', `/api/panel/conversations/${convId}/close`, {}, token);
  assert.equal(closed.body.status, 'closed');
  const closedMsg = await visitor.next((m) => m.t === 'msg' && m.m.code === 'closed');
  assert.ok(closedMsg);

  // --- kapandıktan sonra yazarsa yeni konuşma açılır
  visitor.send({ t: 'msg', cid: 'c2', text: 'Ett till fråga om transfer från flygplatsen' });
  await visitor.next((m) => m.t === 'ack' && m.cid === 'c2');
  const newConv = await agent.next((m) => m.t === 'msg' && m.m.direction === 'in' && m.c.id !== convId);
  assert.equal(newConv.c.status, 'open');

  // --- durum: offline → müşteriye bildirilir
  await json(base, 'POST', '/api/panel/status', { mode: 'offline' }, token);
  assert.equal((await visitor.next((m) => m.t === 'status')).online, false);
  await json(base, 'POST', '/api/panel/status', { mode: 'auto' }, token);

  // --- GDPR silme
  const del = await json(base, 'DELETE', `/api/panel/visitors/${vid}`, null, token);
  assert.deepEqual(del.body, { messages: 9, conversations: 2, visitors: 1 });
  assert.equal((await json(base, 'GET', `/api/panel/conversations/${convId}`, null, token)).status, 404);

  await visitor.close();
  await agent.close();
});

test('mesaj doğrulama ve rate limit', async () => {
  const v = await wsClient(`${wsBase}/ws/visitor?site=spicytravel-fi`, ORIGIN);
  v.send({ t: 'msg', cid: 'x', text: 'moi' });
  assert.equal((await v.next((m) => m.t === 'error')).code, 'hello_first');
  v.send({ t: 'hello' });
  await v.next((m) => m.t === 'welcome');
  v.send({ t: 'msg', cid: 'e', text: '   ' });
  assert.equal((await v.next((m) => m.t === 'error' && m.ref === 'e')).code, 'empty');
  v.send({ t: 'msg', cid: 'l', text: 'a'.repeat(2001) });
  assert.equal((await v.next((m) => m.t === 'error' && m.ref === 'l')).code, 'too_long');
  for (let i = 0; i < 25; i++) v.send({ t: 'msg', cid: `r${i}`, text: `Hei ${i}` });
  const limited = await v.next((m) => m.t === 'error' && m.code === 'rate_limited', 5000);
  assert.ok(limited);
  // honeypot doluysa e-posta kaydedilmez
  v.send({ t: 'email', email: 'bot@spam.com', hp: 'http://spam' });
  assert.equal((await v.next((m) => m.t === 'email_ok')).email, '');
  await v.close();
});
