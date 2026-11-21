import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};
const int = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ConfigError(`Sayı bekleniyordu, gelen: "${v}"`);
  return n;
};
const str = (v, def = '') => (v === undefined || v === null ? def : String(v).trim());
const list = (v, def = []) => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : def;
};

export class ConfigError extends Error {}

/**
 * MongoDB bağlantı adresini oluşturur.
 * MONGODB_URI doluysa onu kullanır; değilse parçalardan kurar ve
 * kullanıcı adı/şifreyi URL-encode eder.
 */
export function buildMongoUri(env) {
  const uri = str(env.MONGODB_URI);
  if (uri) return uri;
  const hosts = list(env.MONGODB_HOSTS, ['127.0.0.1:27017']);
  const user = str(env.MONGODB_USER);
  const pass = str(env.MONGODB_PASSWORD);
  const db = str(env.MONGODB_DB, 'spicychat');
  const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : '';
  const params = new URLSearchParams();
  if (user) params.set('authSource', str(env.MONGODB_AUTH_SOURCE, db));
  if (str(env.MONGODB_REPLICA_SET)) params.set('replicaSet', str(env.MONGODB_REPLICA_SET));
  if (bool(env.MONGODB_DIRECT_CONNECTION) && !str(env.MONGODB_REPLICA_SET) && hosts.length === 1) {
    params.set('directConnection', 'true');
  }
  const q = params.toString();
  return `mongodb://${auth}${hosts.join(',')}/${encodeURIComponent(db)}${q ? `?${q}` : ''}`;
}

/** Şifreyi gizleyerek URI'yi loglanabilir hale getirir. */
export function redactUri(uri) {
  return String(uri).replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@');
}

function readJson(file, fallback) {
  const full = path.join(ROOT_DIR, file);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file} okunamadı: ${e.message}`);
  }
}

export function loadConfig(env = process.env, { loadFiles = true } = {}) {
  const errors = [];
  const nodeEnv = str(env.NODE_ENV, 'development');
  const isProd = nodeEnv === 'production';

  const dbDriver = str(env.DB_DRIVER, 'mongo');
  if (!['mongo', 'memory'].includes(dbDriver)) errors.push('DB_DRIVER "mongo" ya da "memory" olmalı');

  const translationProvider = str(env.TRANSLATION_PROVIDER, 'mock');
  if (!['mock', 'anthropic', 'deepl'].includes(translationProvider)) {
    errors.push('TRANSLATION_PROVIDER "mock", "anthropic" ya da "deepl" olmalı');
  }
  if (translationProvider === 'anthropic' && !str(env.ANTHROPIC_API_KEY)) errors.push('ANTHROPIC_API_KEY boş');
  if (translationProvider === 'deepl' && !str(env.DEEPL_API_KEY)) errors.push('DEEPL_API_KEY boş');

  const sessionSecret = str(env.SESSION_SECRET);
  if (sessionSecret.length < 32) {
    if (isProd) errors.push('SESSION_SECRET en az 32 karakter olmalı');
  }
  const panelPassword = str(env.PANEL_PASSWORD);
  if (!panelPassword) errors.push('PANEL_PASSWORD boş');
  if (isProd && ['degistir-beni', 'changeme'].includes(panelPassword)) errors.push('PANEL_PASSWORD varsayılan değerde');

  const telegramToken = str(env.TELEGRAM_BOT_TOKEN);
  const telegramGroupId = str(env.TELEGRAM_GROUP_ID);
  if (telegramToken && !telegramGroupId) errors.push('TELEGRAM_BOT_TOKEN dolu ama TELEGRAM_GROUP_ID boş');

  const mongo = {
    uri: dbDriver === 'mongo' ? buildMongoUri(env) : '',
    dbName: str(env.MONGODB_DB, 'spicychat'),
    options: {
      appName: str(env.MONGODB_APP_NAME, 'spicy-chat'),
      maxPoolSize: int(env.MONGODB_MAX_POOL_SIZE, 20),
      minPoolSize: int(env.MONGODB_MIN_POOL_SIZE, 0),
      serverSelectionTimeoutMS: int(env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 8000),
      connectTimeoutMS: int(env.MONGODB_CONNECT_TIMEOUT_MS, 10000),
      retryWrites: bool(env.MONGODB_RETRY_WRITES, true),
      writeConcern: { w: /^\d+$/.test(str(env.MONGODB_WRITE_CONCERN)) ? Number(env.MONGODB_WRITE_CONCERN) : str(env.MONGODB_WRITE_CONCERN, 'majority') },
    },
    autoIndex: bool(env.MONGODB_AUTO_INDEX, false),
  };
  if (bool(env.MONGODB_TLS)) {
    mongo.options.tls = true;
    if (str(env.MONGODB_TLS_CA_FILE)) mongo.options.tlsCAFile = str(env.MONGODB_TLS_CA_FILE);
    if (str(env.MONGODB_TLS_CERT_KEY_FILE)) mongo.options.tlsCertificateKeyFile = str(env.MONGODB_TLS_CERT_KEY_FILE);
    if (bool(env.MONGODB_TLS_ALLOW_INVALID_HOSTNAMES)) {
      if (isProd) errors.push('MONGODB_TLS_ALLOW_INVALID_HOSTNAMES canlıda true olamaz');
      mongo.options.tlsAllowInvalidHostnames = true;
    }
    for (const f of [mongo.options.tlsCAFile, mongo.options.tlsCertificateKeyFile]) {
      if (f && loadFiles && !fs.existsSync(f)) errors.push(`TLS dosyası bulunamadı: ${f}`);
    }
  }
  if (dbDriver === 'mongo' && !str(env.MONGODB_URI) && str(env.MONGODB_USER) && !str(env.MONGODB_PASSWORD)) {
    errors.push('MONGODB_USER dolu ama MONGODB_PASSWORD boş');
  }

  const sites = loadFiles ? readJson('config/sites.json', []) : (env.__sites || []);
  const agents = loadFiles ? readJson('config/agents.json', []) : (env.__agents || []);
  const glossary = loadFiles ? readJson('config/glossary.json', { keep: [] }) : (env.__glossary || { keep: [] });
  if (!Array.isArray(sites) || sites.length === 0) errors.push('config/sites.json boş ya da hatalı');
  for (const s of sites) {
    if (!s.id || !s.defaultLang) errors.push(`config/sites.json: her sitede "id" ve "defaultLang" olmalı (${JSON.stringify(s).slice(0, 60)})`);
  }
  if (!Array.isArray(agents) || agents.length === 0) errors.push('config/agents.json boş ya da hatalı');

  if (errors.length) {
    throw new ConfigError(`Ayar hataları:\n  - ${errors.join('\n  - ')}`);
  }

  return Object.freeze({
    nodeEnv,
    isProd,
    port: int(env.PORT, 3000),
    // Render gibi platformlar kendi adresini RENDER_EXTERNAL_URL ile verir
    publicBaseUrl: (str(env.PUBLIC_BASE_URL) || str(env.RENDER_EXTERNAL_URL) || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
    logLevel: str(env.LOG_LEVEL, 'info'),
    sessionSecret: sessionSecret || 'dev-only-insecure-secret-change-me-please',
    panelPassword,
    serveTestPages: bool(env.SERVE_TEST_PAGES, !isProd),
    dbDriver,
    mongo,
    retentionDays: int(env.DATA_RETENTION_DAYS, 0),
    translation: {
      provider: translationProvider,
      teamLangs: list(env.TEAM_LANGS, ['tr', 'en']),
      teamTargetLang: str(env.TEAM_TARGET_LANG, 'tr'),
      timeoutMs: int(env.TRANSLATION_TIMEOUT_MS, 12000),
      anthropic: {
        apiKey: str(env.ANTHROPIC_API_KEY),
        model: str(env.ANTHROPIC_MODEL, 'claude-haiku-5-5'),
        apiBase: str(env.ANTHROPIC_API_BASE, 'https://api.anthropic.com').replace(/\/$/, ''),
      },
      deepl: { apiKey: str(env.DEEPL_API_KEY) },
    },
    telegram: {
      enabled: Boolean(telegramToken),
      token: telegramToken,
      groupId: telegramGroupId,
      allowAllGroupMembers: bool(env.TELEGRAM_ALLOW_ALL_GROUP_MEMBERS, true),
      apiBase: str(env.TELEGRAM_API_BASE, 'https://api.telegram.org').replace(/\/$/, ''),
    },
    email: {
      smtpHost: str(env.SMTP_HOST),
      smtpPort: int(env.SMTP_PORT, 587),
      smtpSecure: bool(env.SMTP_SECURE, false),
      smtpUser: str(env.SMTP_USER),
      smtpPassword: str(env.SMTP_PASSWORD),
      from: str(env.MAIL_FROM, 'Spicy Travel <support@spicytravel.se>'),
      replyTo: str(env.MAIL_REPLY_TO),
      debounceSeconds: int(env.EMAIL_DEBOUNCE_SECONDS, 60),
      outboxDir: str(env.MAIL_OUTBOX_DIR, path.join(ROOT_DIR, 'var', 'outbox')),
    },
    support: {
      hours: str(env.SUPPORT_HOURS, 'mon-fri 09:00-18:00'),
      timezone: str(env.SUPPORT_TIMEZONE, 'Europe/Stockholm'),
    },
    limits: {
      messagesPerMinute: int(env.RATE_LIMIT_MESSAGES_PER_MINUTE, 20),
      connectionsPerMinute: int(env.RATE_LIMIT_CONNECTIONS_PER_MINUTE, 30),
      maxMessageLength: int(env.MAX_MESSAGE_LENGTH, 2000),
    },
    sites,
    agents,
    glossary,
  });
}

let cached;
/** .env dosyasını yükleyip ayarları bir kez okur. */
export function getConfig() {
  if (!cached) {
    dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });
    cached = loadConfig(process.env);
  }
  return cached;
}
