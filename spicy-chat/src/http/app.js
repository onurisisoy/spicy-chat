import path from 'node:path';
import express from 'express';
import { ROOT_DIR } from '../config.js';
import { ChatError } from '../chat/service.js';
import { signToken, verifyToken, safeEqual } from '../util/auth.js';
import { createRateLimiter } from '../util/ratelimit.js';
import { clientIp } from '../realtime/hub.js';
import { isOriginAllowed } from '../util/origins.js';

const PUBLIC = path.join(ROOT_DIR, 'public');

export function createApp({ cfg, service, repo, getStats, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const loginLimiter = createRateLimiter({ limit: 10 });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ------------------------------------------------------------ genel
  app.get('/healthz', wrap(async (req, res) => {
    let db = 'ok';
    try {
      await repo.ping();
    } catch (e) {
      db = `hata: ${e.message}`;
    }
    res.status(db === 'ok' ? 200 : 503).json({
      ok: db === 'ok',
      db,
      dbDriver: repo.driver,
      translation: cfg.translation.provider,
      telegram: cfg.telegram.enabled,
      status: service.getStatus(),
      connections: getStats(),
    });
  }));

  // ------------------------------------------------------------ widget
  app.get('/widget.js', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', cfg.isProd ? 'public, max-age=300' : 'no-cache');
    res.sendFile(path.join(PUBLIC, 'widget.js'));
  });

  app.get('/api/widget/config', (req, res) => {
    const site = cfg.sites.find((s) => s.id === req.query.site);
    if (!site) return res.status(404).json({ error: 'unknown_site' });
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(cfg, site, origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.json({
      site: { id: site.id, name: site.name, defaultLang: site.defaultLang, brandColor: site.brandColor || '#0F766E' },
      online: service.getStatus().online,
    });
  });

  // ------------------------------------------------------------ panel API
  const panel = express.Router();

  panel.get('/agents', (req, res) => {
    res.json(cfg.agents.map((a) => ({ id: a.id, name: a.name })));
  });

  panel.post('/login', (req, res) => {
    if (!loginLimiter.hit(clientIp(req))) return res.status(429).json({ error: 'rate_limited', message: 'Çok fazla deneme, 1 dakika bekle' });
    const { agentId, password } = req.body || {};
    const agent = cfg.agents.find((a) => a.id === agentId);
    if (!agent || !safeEqual(password || '', cfg.panelPassword)) {
      return res.status(401).json({ error: 'invalid_login', message: 'İsim ya da şifre hatalı' });
    }
    log.info(`Panel girişi: ${agent.name}`);
    res.json({ token: signToken({ sub: agent.id }, cfg.sessionSecret), agent: { id: agent.id, name: agent.name } });
  });

  panel.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const payload = verifyToken(auth.replace(/^Bearer\s+/i, ''), cfg.sessionSecret);
    const agent = payload && cfg.agents.find((a) => a.id === payload.sub);
    if (!agent) return res.status(401).json({ error: 'unauthorized' });
    req.agent = agent;
    next();
  });

  panel.get('/me', (req, res) => res.json({ agent: { id: req.agent.id, name: req.agent.name }, status: service.getStatus() }));

  panel.get('/sites', (req, res) => res.json(cfg.sites.map((s) => ({ id: s.id, name: s.name, domain: s.domain, defaultLang: s.defaultLang }))));

  panel.get('/conversations', wrap(async (req, res) => {
    const list = await service.listConversations({
      status: req.query.status || 'open',
      siteId: req.query.site || undefined,
      limit: Number(req.query.limit) || 100,
    });
    res.json(list);
  }));

  panel.get('/conversations/:id', wrap(async (req, res) => {
    res.json(await service.getConversationDetail(req.params.id));
  }));

  panel.post('/conversations/:id/messages', wrap(async (req, res) => {
    const m = await service.agentMessage({
      conversationId: req.params.id,
      agent: req.agent,
      text: req.body?.text,
      note: Boolean(req.body?.note),
      channel: 'panel',
    });
    res.status(201).json(m);
  }));

  panel.post('/conversations/:id/read', wrap(async (req, res) => {
    res.json(await service.markRead(req.params.id));
  }));

  panel.post('/conversations/:id/close', wrap(async (req, res) => {
    res.json(await service.closeConversation({ conversationId: req.params.id, agent: req.agent, channel: 'panel' }));
  }));

  panel.post('/conversations/:id/ask-email', wrap(async (req, res) => {
    await service.requestEmail({ conversationId: req.params.id, agent: req.agent, channel: 'panel' });
    res.json({ ok: true });
  }));

  panel.get('/status', (req, res) => res.json(service.getStatus()));
  panel.post('/status', (req, res) => {
    try {
      res.json(service.setStatusMode(req.body?.mode));
    } catch (e) {
      res.status(400).json({ error: 'bad_mode', message: e.message });
    }
  });

  panel.delete('/visitors/:id', wrap(async (req, res) => {
    const r = await service.deleteVisitor(req.params.id);
    log.info(`GDPR silme (${req.agent.name}): ziyaretçi ${req.params.id} → ${JSON.stringify(r)}`);
    res.json(r);
  }));

  app.use('/api/panel', panel);

  // ------------------------------------------------------------ statik
  app.use('/panel', express.static(path.join(PUBLIC, 'panel'), { index: 'index.html' }));
  if (cfg.serveTestPages) app.use('/test', express.static(path.join(PUBLIC, 'test'), { index: 'index.html' }));
  app.get('/', (req, res) => res.redirect(cfg.serveTestPages ? '/test/' : '/panel/'));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ChatError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
    log.error(`HTTP hatası: ${err.stack || err.message}`);
    res.status(500).json({ error: 'server_error' });
  });

  app.locals.stop = () => loginLimiter.stop();
  return app;
}
