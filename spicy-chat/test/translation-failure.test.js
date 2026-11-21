import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { createTranslator } from '../src/translate/index.js';
import { testConfig, wsClient, json } from './helpers.js';

const ORIGIN = { origin: 'http://localhost:3000' };

test('çeviri API\'si çökerse mesaj kaybolmaz, orijinal iletilir', async () => {
  const { cfg } = testConfig();
  const broken = { name: 'broken', translate: async () => { throw new Error('503 overloaded'); } };
  const app = await startServer(cfg, { port: 0, translatorProvider: broken });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { body: { token } } = await json(base, 'POST', '/api/panel/login', { agentId: 'onur', password: 'test-pass' });
    const agent = await wsClient(`ws://127.0.0.1:${app.port}/ws/agent?token=${encodeURIComponent(token)}`);
    const v = await wsClient(`ws://127.0.0.1:${app.port}/ws/visitor?site=spicytravel-se`, ORIGIN);
    v.send({ t: 'hello' });
    await v.next((m) => m.t === 'welcome');
    v.send({ t: 'msg', cid: '1', text: 'Hej, jag har en fråga om min bokning' });
    const inbound = await agent.next((m) => m.t === 'msg' && m.m.direction === 'in');
    assert.equal(inbound.m.translation.ok, false);
    assert.equal(inbound.m.translation.text, 'Hej, jag har en fråga om min bokning');
    assert.match(inbound.m.translation.error, /503/);
    await json(base, 'POST', `/api/panel/conversations/${inbound.c.id}/messages`, { text: 'Merhaba, hemen bakıyorum' }, token);
    const out = await v.next((m) => m.t === 'msg');
    assert.equal(out.m.text, 'Merhaba, hemen bakıyorum');
    await v.close();
    await agent.close();
  } finally {
    await app.close();
  }
});

test('çeviri zaman aşımı', async () => {
  const { cfg } = testConfig({ TRANSLATION_TIMEOUT_MS: '50' });
  const slow = { name: 'slow', translate: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) };
  const t = createTranslator(cfg, { debug() {}, warn() {} }, { provider: slow });
  const r = await t.translate({ text: 'Hei', to: 'tr' });
  assert.equal(r.ok, false);
  assert.match(r.error, /zaman aşımı/);
});

test('Anthropic sağlayıcısı: istek biçimi ve JSON cevabı', async () => {
  const { anthropicProvider } = await import('../src/translate/providers.js');
  const realFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init: { ...init, body: JSON.parse(init.body) } };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '```json\n{"detected_lang":"sv","translation":"Merhaba! 12 Mayıs\'ta yer var mı?"}\n```' }] }), { status: 200 });
  };
  try {
    const p = anthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', apiBase: 'https://api.anthropic.com' });
    const r = await p.translate({ text: 'Hej! Finns det plats den 12 maj i Alanya?', to: 'tr', skipIfIn: ['tr', 'en'], glossary: ['Alanya', 'Side'] });
    assert.deepEqual(r, { text: "Merhaba! 12 Mayıs'ta yer var mı?", detectedLang: 'sv', translated: true });
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.init.headers['x-api-key'], 'k');
    assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
    assert.equal(captured.init.body.model, 'claude-haiku-5-5');
    assert.match(captured.init.body.system, /"Alanya"/);
    assert.doesNotMatch(captured.init.body.system, /"Side"/);
    assert.match(captured.init.body.messages[0].content, /<message>\nHej!/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('DeepL sağlayıcısı: free/pro adresi ve koruma etiketleri', async () => {
  const { deeplProvider } = await import('../src/translate/providers.js');
  const realFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ translations: [{ detected_source_language: 'FI', text: 'Merhaba, <x>Antalya</x> otelinde yer var mı?' }] }), { status: 200 });
  };
  try {
    const r = await deeplProvider({ apiKey: 'abc:fx' }).translate({ text: 'Hei, onko Antalya hotellissa tilaa?', to: 'tr', glossary: ['Antalya'] });
    assert.equal(captured.url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(captured.auth, 'DeepL-Auth-Key abc:fx');
    assert.equal(captured.body.target_lang, 'TR');
    assert.deepEqual(captured.body.ignore_tags, ['x']);
    assert.equal(captured.body.text[0], 'Hei, onko <x>Antalya</x> hotellissa tilaa?');
    assert.deepEqual(r, { text: 'Merhaba, Antalya otelinde yer var mı?', detectedLang: 'fi', translated: true });
    await deeplProvider({ apiKey: 'pro-key' }).translate({ text: 'x', to: 'sv' });
    assert.equal(captured.url, 'https://api.deepl.com/v2/translate');
  } finally {
    globalThis.fetch = realFetch;
  }
});
