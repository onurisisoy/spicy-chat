import http from 'node:http';
import { createLogger, setLogLevel } from './logger.js';
import { createRepo } from './db/index.js';
import { createTranslator } from './translate/index.js';
import { createMailer } from './email/mailer.js';
import { createPresence } from './util/presence.js';
import { createChatService } from './chat/service.js';
import { createApp } from './http/app.js';
import { attachHub } from './realtime/hub.js';
import { createTelegramBot } from './telegram/bot.js';

/**
 * Tüm parçaları kurar ve HTTP sunucusunu başlatır.
 * Testler de bunu kullanır (port 0 = rastgele boş port).
 */
export async function startServer(cfg, { port = cfg.port, translatorProvider } = {}) {
  setLogLevel(cfg.logLevel);
  const log = createLogger('app');
  const repo = await createRepo(cfg, createLogger('db'));
  const translator = createTranslator(cfg, createLogger('ceviri'), { provider: translatorProvider });
  const mailer = createMailer(cfg, createLogger('eposta'));
  const presence = createPresence(cfg.support);
  const service = createChatService({ cfg, repo, translator, mailer, presence, log: createLogger('chat') });

  let hub;
  const app = createApp({ cfg, service, repo, getStats: () => hub?.stats(), log: createLogger('http') });
  const server = http.createServer(app);
  hub = attachHub({ server, cfg, service, log: createLogger('ws') });

  // Çalışma saati sınırı geçilince (09:00, 18:00) widget'lara yeni durumu bildir
  let lastOnline = presence.isOnline();
  const presenceTimer = setInterval(() => {
    const now = presence.isOnline();
    if (now !== lastOnline) {
      lastOnline = now;
      service.events.emit('status', service.getStatus());
    }
  }, 30_000);
  presenceTimer.unref();
  service.events.on('status', (s) => (lastOnline = s.online));

  let bot = null;
  if (cfg.telegram.enabled) {
    bot = createTelegramBot({ cfg, service, log: createLogger('telegram') });
    try {
      await bot.start();
    } catch (e) {
      log.error(`Telegram başlatılamadı (panel çalışmaya devam ediyor): ${e.message}`);
      bot = null;
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  const actualPort = server.address().port;

  log.info(`Hazır → http://localhost:${actualPort}`);
  log.info(`  Panel       : http://localhost:${actualPort}/panel/`);
  if (cfg.serveTestPages) log.info(`  Test siteleri: http://localhost:${actualPort}/test/`);
  log.info(`  Veritabanı  : ${repo.driver} · Çeviri: ${translator.provider} · Telegram: ${bot ? 'açık' : 'kapalı'} · E-posta: ${mailer.mode}`);

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(presenceTimer);
    await bot?.stop();
    await service.flushAllEmails().catch(() => {});
    hub.close();
    app.locals.stop?.();
    await new Promise((r) => server.close(() => r()));
    await repo.close();
  }

  return { server, port: actualPort, service, repo, bot, hub, close };
}
