import { getConfig, ConfigError } from './config.js';
import { startServer } from './server.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

async function main() {
  let cfg;
  try {
    cfg = getConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\n${e.message}\n\n.env dosyasını kontrol et (örnek: .env.example).\n`);
      process.exit(1);
    }
    throw e;
  }

  let app;
  try {
    app = await startServer(cfg);
  } catch (e) {
    log.error(`Başlatılamadı: ${e.message}`);
    if (cfg.dbDriver === 'mongo') log.error('MongoDB ayarlarını kontrol etmek için: npm run db:check');
    if (e.code === 'EADDRINUSE') log.error(`Port ${cfg.port} kullanımda. .env içinde PORT'u değiştir.`);
    process.exit(1);
  }

  const shutdown = async (signal) => {
    log.info(`${signal} alındı, kapatılıyor…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close().catch((e) => log.error(e.message));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error(`Yakalanmamış hata: ${e?.stack || e}`));
}

main();
