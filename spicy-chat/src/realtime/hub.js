import { WebSocketServer } from 'ws';
import { toVisitorView, ChatError } from '../chat/service.js';
import { verifyToken } from '../util/auth.js';
import { createRateLimiter } from '../util/ratelimit.js';
import { isOriginAllowed } from '../util/origins.js';

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

/**
 * WebSocket merkezi.
 *   /ws/visitor?site=<siteId>   → widget
 *   /ws/agent?token=<token>     → panel
 */
export function attachHub({ server, cfg, service, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const visitorSockets = new Map(); // visitorId → Set<ws>
  const agentSockets = new Set();
  const connLimiter = createRateLimiter({ limit: cfg.limits.connectionsPerMinute });
  const msgLimiter = createRateLimiter({ limit: cfg.limits.messagesPerMinute });

  service.setVisitorPresenceCheck((visitorId) => (visitorSockets.get(visitorId)?.size || 0) > 0);

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const ip = clientIp(req);

    if (url.pathname === '/ws/visitor') {
      if (!connLimiter.hit(`ip:${ip}`)) return reject(429, 'Too Many Requests');
      const siteId = url.searchParams.get('site') || '';
      const site = cfg.sites.find((s) => s.id === siteId);
      if (!site) return reject(404, 'Unknown Site');
      const origin = req.headers.origin;
      if (!isOriginAllowed(cfg, site, origin)) {
        log.warn(`Reddedilen origin: ${origin} (site ${siteId})`);
        return reject(403, 'Forbidden');
      }
      wss.handleUpgrade(req, socket, head, (ws) => onVisitor(ws, req, site, ip));
      return;
    }
    if (url.pathname === '/ws/agent') {
      const payload = verifyToken(url.searchParams.get('token'), cfg.sessionSecret);
      const agent = payload && cfg.agents.find((a) => a.id === payload.sub);
      if (!agent) return reject(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, agent));
      return;
    }
    socket.destroy();
  });

  function onVisitor(ws, req, site, ip) {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    let visitorId = null;

    const fail = (e, ref) => {
      const code = e instanceof ChatError ? e.code : 'server_error';
      if (!(e instanceof ChatError)) log.error(`Widget hatası: ${e.stack || e.message}`);
      send(ws, { t: 'error', code, ref });
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { t: 'error', code: 'bad_json' });
      }
      try {
        if (msg.t === 'ping') return send(ws, { t: 'pong' });
        if (msg.t === 'hello') {
          const r = await service.visitorHello({
            siteId: site.id,
            visitorId: msg.vid,
            lang: msg.lang,
            page: msg.page,
            userAgent: req.headers['user-agent'],
          });
          if (visitorId && visitorId !== r.visitor.id) visitorSockets.get(visitorId)?.delete(ws);
          visitorId = r.visitor.id;
          if (!visitorSockets.has(visitorId)) visitorSockets.set(visitorId, new Set());
          visitorSockets.get(visitorId).add(ws);
          return send(ws, {
            t: 'welcome',
            vid: visitorId,
            online: r.online,
            emailKnown: Boolean(r.visitor.email),
            closed: r.conversation?.status === 'closed',
            messages: r.messages,
          });
        }
        if (!visitorId) return send(ws, { t: 'error', code: 'hello_first' });
        if (msg.t === 'msg') {
          if (!msgLimiter.hit(`v:${visitorId}`) || !msgLimiter.hit(`ip:${ip}`)) {
            return send(ws, { t: 'error', code: 'rate_limited', ref: msg.cid });
          }
          const m = await service.visitorMessage({ visitorId, text: msg.text, page: msg.page });
          return send(ws, { t: 'ack', cid: msg.cid, m: toVisitorView(m) });
        }
        if (msg.t === 'email') {
          // Honeypot: gerçek kullanıcı bu gizli alanı doldurmaz
          if (msg.hp) return send(ws, { t: 'email_ok', email: '' });
          const email = await service.visitorSetEmail({ visitorId, email: msg.email });
          return send(ws, { t: 'email_ok', email });
        }
        return send(ws, { t: 'error', code: 'unknown_type' });
      } catch (e) {
        fail(e, msg.cid);
      }
    });

    ws.on('close', () => {
      if (!visitorId) return;
      const set = visitorSockets.get(visitorId);
      set?.delete(ws);
      if (set && set.size === 0) visitorSockets.delete(visitorId);
    });
  }

  function onAgent(ws, agent) {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    agentSockets.add(ws);
    send(ws, { t: 'hello', agent: { id: agent.id, name: agent.name }, status: service.getStatus() });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'ping') send(ws, { t: 'pong' });
      } catch {
        /* yok say */
      }
    });
    ws.on('close', () => agentSockets.delete(ws));
  }

  const toAgents = (payload) => {
    const data = JSON.stringify(payload);
    for (const ws of agentSockets) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const toVisitor = (visitorId, payload) => {
    const set = visitorSockets.get(visitorId);
    if (!set) return 0;
    for (const ws of set) send(ws, payload);
    return set.size;
  };

  const onMessage = ({ message, conversation }) => {
    toAgents({ t: 'msg', m: message, c: conversation });
    if (message.direction === 'in') {
      // Müşterinin diğer sekmeleri de görsün
      const view = toVisitorView(message);
      const set = visitorSockets.get(conversation.visitorId);
      if (set && set.size > 1) toVisitor(conversation.visitorId, { t: 'msg', m: view, echo: true });
      return;
    }
    const view = toVisitorView(message);
    if (view) toVisitor(conversation.visitorId, { t: 'msg', m: view });
  };
  const onConversation = (c) => toAgents({ t: 'conv', c });
  const onStatus = (s) => {
    toAgents({ t: 'status', status: s });
    const data = JSON.stringify({ t: 'status', online: s.online });
    for (const set of visitorSockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  service.events.on('message', onMessage);
  service.events.on('conversation', onConversation);
  service.events.on('status', onStatus);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  return {
    stats: () => ({ visitors: visitorSockets.size, agents: agentSockets.size }),
    close() {
      clearInterval(heartbeat);
      connLimiter.stop();
      msgLimiter.stop();
      service.events.off('message', onMessage);
      service.events.off('conversation', onConversation);
      service.events.off('status', onStatus);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
