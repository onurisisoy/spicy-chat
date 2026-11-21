#!/usr/bin/env node
/**
 * Kurulu bir sunucuyu uçtan uca kontrol eder (lokal ya da Render).
 *   PANEL_PASSWORD=... npm run smoke -- https://spicy-chat.onrender.com
 *
 * Adımlar: sağlık → widget.js → panel girişi → müşteri bağlanır ve yazar →
 * panel mesajı alır → ekip cevaplar → müşteri kendi dilinde alır → test verisi silinir.
 * Ücretsiz Render uyuyorsa ilk istek ~1 dakika sürebilir; script bekler.
 */
import WebSocket from 'ws';

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const password = process.env.PANEL_PASSWORD;
const agentId = process.env.AGENT_ID || 'onur';
const siteId = process.env.SITE_ID || 'spicytravel-se';
const wsBase = base.replace(/^http/, 'ws');
const origin = new URL(base).origin;

let failed = false;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  failed = true;
  console.log(`  ✖ ${m}`);
};

function client(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.on('open', () =>
      resolve({
        send: (o) => ws.send(JSON.stringify(o)),
        next: (pred, timeout = 30000) => {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res };
            waiters.push(w);
            setTimeout(() => rej(new Error('cevap gelmedi (30 sn)')), timeout).unref();
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function wake() {
  const end = Date.now() + 120_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(70_000) });
      if (r.status < 502) return r;
    } catch {
      /* uyanıyor */
    }
    if (Date.now() > end) throw new Error('Sunucu 2 dakikada cevap vermedi');
    process.stdout.write('  … sunucu uyanıyor\n');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  console.log(`\nKontrol: ${base}\n`);
  if (!password) {
    console.log('PANEL_PASSWORD ortam değişkeni gerekli:  PANEL_PASSWORD=... npm run smoke -- <adres>\n');
    process.exit(1);
  }

  const h = await wake();
  const health = await h.json();
  if (health.ok) ok(`Sağlık: db=${health.dbDriver}, çeviri=${health.translation}, telegram=${health.telegram ? 'açık' : 'kapalı'}, durum=${health.status.online ? 'online' : 'offline'}`);
  else bad(`Sağlık: ${JSON.stringify(health)}`);
  if (health.dbDriver === 'memory') console.log('    (memory modunda: yeniden başlayınca veriler silinir)');

  const w = await fetch(`${base}/widget.js`);
  if (w.ok && /Spicy Chat widget/.test(await w.text())) ok('widget.js yükleniyor');
  else bad(`widget.js: HTTP ${w.status}`);

  const cfg = await api('GET', `/api/widget/config?site=${siteId}`);
  if (cfg.status === 200) ok(`Site ayarı: ${cfg.data.site.name} (${cfg.data.site.defaultLang})`);
  else bad(`Site ayarı: HTTP ${cfg.status}`);

  const login = await api('POST', '/api/panel/login', { agentId, password });
  if (login.status !== 200) {
    bad(`Panel girişi: ${login.data.message || login.status}`);
    process.exit(1);
  }
  ok(`Panel girişi: ${login.data.agent.name}`);
  const token = login.data.token;

  const agent = await client(`${wsBase}/ws/agent?token=${encodeURIComponent(token)}`);
  await agent.next((m) => m.t === 'hello');
  ok('Panel canlı bağlantısı');

  const visitor = await client(`${wsBase}/ws/visitor?site=${siteId}`, { origin });
  visitor.send({ t: 'hello', lang: 'sv-SE', page: { url: `${base}/test/se.html`, title: 'Smoke test' } });
  const welcome = await visitor.next((m) => m.t === 'welcome');
  ok(`Müşteri bağlandı (#${welcome.vid.slice(0, 4).toUpperCase()})`);

  const started = Date.now();
  visitor.send({ t: 'msg', cid: 's1', text: 'Hej! Finns det plats den 12 maj för två vuxna? (smoke test)' });
  await visitor.next((m) => m.t === 'ack' && m.cid === 's1');
  const inbound = await agent.next((m) => m.t === 'msg' && m.m.direction === 'in' && m.c.visitorId === welcome.vid);
  const t = inbound.m.translation;
  if (t.ok) ok(`Müşteri → ekip: "${t.text.slice(0, 70)}" (${inbound.m.lang}→${t.lang}, ${Date.now() - started} ms)`);
  else bad(`Çeviri başarısız: ${t.error}`);

  const replyStarted = Date.now();
  const sent = await api('POST', `/api/panel/conversations/${inbound.c.id}/messages`, { text: 'Merhaba, evet 12 Mayıs için yer var. Teşekkürler! (smoke test)' }, token);
  if (sent.status !== 201) bad(`Ekip cevabı: ${JSON.stringify(sent.data)}`);
  const reply = await visitor.next((m) => m.t === 'msg' && m.m.dir === 'out');
  ok(`Ekip → müşteri: "${reply.m.text.slice(0, 70)}" (${Date.now() - replyStarted} ms)`);

  const del = await api('DELETE', `/api/panel/visitors/${welcome.vid}`, null, token);
  if (del.status === 200) ok(`Test verisi silindi (${del.data.messages} mesaj)`);
  else bad(`Test verisi silinemedi: HTTP ${del.status}`);

  visitor.close();
  agent.close();
  console.log(failed ? '\nSonuç: SORUN VAR (yukarıdaki ✖ satırlarına bak)\n' : '\nSonuç: her şey çalışıyor.\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(`  ✖ ${e.message}\n`);
  process.exit(1);
});
