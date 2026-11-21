import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';

export function testConfig(env = {}) {
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'spicy-outbox-'));
  const cfg = loadConfig(
    {
      DB_DRIVER: 'memory',
      PANEL_PASSWORD: 'test-pass',
      SESSION_SECRET: 'x'.repeat(40),
      TRANSLATION_PROVIDER: 'mock',
      LOG_LEVEL: 'silent',
      EMAIL_DEBOUNCE_SECONDS: '0',
      MAIL_OUTBOX_DIR: outbox,
      SUPPORT_HOURS: 'mon-sun 00:00-23:59',
      SUPPORT_TIMEZONE: 'UTC',
      ...env,
    },
    { loadFiles: true },
  );
  return { cfg, outbox };
}

/** Mesajları kuyruğa alan WebSocket istemcisi. */
export function wsClient(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else queue.push(msg);
    });
    ws.on('open', () =>
      resolve({
        ws,
        send: (o) => ws.send(JSON.stringify(o)),
        next(pred = () => true, timeout = 3000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res };
            w.timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error(`WS mesajı gelmedi (${pred.toString().slice(0, 80)})`));
            }, timeout);
            waiters.push(w);
          });
        },
        drain: () => queue.splice(0),
        close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
      }),
    );
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
  });
}

export async function json(base, method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

export const waitFor = async (fn, timeout = 3000, step = 25) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor zaman aşımı');
    await new Promise((r) => setTimeout(r, step));
  }
};

/** Telegram Bot API taklidi: çağrıları kaydeder, getUpdates ile güncelleme verir. */
export function fakeTelegram() {
  const calls = [];
  const pendingUpdates = [];
  let updateId = 1;
  let topicSeq = 100;
  let msgSeq = 1000;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      const params = body ? JSON.parse(body) : {};
      calls.push({ method, params });
      const ok = (result) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
      };
      switch (method) {
        case 'getMe':
          return ok({ id: 999, is_bot: true, username: 'spicy_test_bot', can_read_all_group_messages: true });
        case 'getChat':
          return ok({ id: params.chat_id, type: 'supergroup', title: 'Destek', is_forum: true });
        case 'getChatMember':
          return ok({ status: 'administrator', can_manage_topics: true });
        case 'createForumTopic':
          return ok({ message_thread_id: ++topicSeq, name: params.name });
        case 'sendMessage':
          return ok({ message_id: ++msgSeq, chat: { id: params.chat_id }, text: params.text });
        case 'closeForumTopic':
        case 'reopenForumTopic':
          return ok(true);
        case 'getUpdates': {
          const end = Date.now() + 300;
          while (!pendingUpdates.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
          return ok(pendingUpdates.splice(0));
        }
        default:
          return ok(true);
      }
    });
  });
  return {
    calls,
    async start() {
      await new Promise((r) => server.listen(0, r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    push(message) {
      pendingUpdates.push({ update_id: updateId++, message: { message_id: ++msgSeq, date: Math.floor(Date.now() / 1000), ...message } });
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
