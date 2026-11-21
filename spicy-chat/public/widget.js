/*!
 * Spicy Chat widget
 * Kullanım:
 *   <script src="https://chat.ORNEK.com/widget.js" data-site="spicytravel-se" async></script>
 * İsteğe bağlı: data-lang="sv|fi|da|en"  data-position="right|left"
 */
(function () {
  'use strict';
  if (window.__spicyChatLoaded) return;
  window.__spicyChatLoaded = true;

  var script =
    document.currentScript ||
    (function () {
      var list = document.querySelectorAll('script[data-site]');
      for (var i = 0; i < list.length; i++) if (/widget\.js/.test(list[i].src)) return list[i];
      return null;
    })();
  if (!script || !script.dataset.site) {
    console.warn('[spicy-chat] data-site eksik');
    return;
  }

  var BASE = new URL(script.src, location.href).origin;
  var SITE = script.dataset.site;
  var POSITION = script.dataset.position === 'left' ? 'left' : 'right';
  var WS_URL = BASE.replace(/^http/, 'ws') + '/ws/visitor?site=' + encodeURIComponent(SITE);

  var I18N = {
    sv: {
      title: 'Chatta med oss', placeholder: 'Skriv ett meddelande…', send: 'Skicka', online: 'Vi är online',
      offline: 'Lämna ett meddelande – vi svarar via e-post', open: 'Öppna chatten', close: 'Stäng chatten',
      greeting: 'Hej! Hur kan vi hjälpa dig?', translated: 'Meddelanden översätts automatiskt.',
      emailPrompt: 'Ange din e-post så att vi kan svara även om du lämnar sidan.', emailPlaceholder: 'din@e-post.se',
      save: 'Spara', emailSaved: 'Tack! Vi svarar till {email}.', emailInvalid: 'Kontrollera e-postadressen.',
      closed: 'Konversationen har avslutats. Skriv igen om du har fler frågor.', connecting: 'Ansluter…',
      failed: 'Kunde inte skicka. Försöker igen…', rateLimited: 'Du skickar för snabbt. Vänta en stund.', tooLong: 'Meddelandet är för långt.',
    },
    fi: {
      title: 'Keskustele kanssamme', placeholder: 'Kirjoita viesti…', send: 'Lähetä', online: 'Olemme paikalla',
      offline: 'Jätä viesti – vastaamme sähköpostitse', open: 'Avaa chat', close: 'Sulje chat',
      greeting: 'Hei! Miten voimme auttaa?', translated: 'Viestit käännetään automaattisesti.',
      emailPrompt: 'Anna sähköpostiosoitteesi, niin voimme vastata, vaikka poistuisit sivulta.', emailPlaceholder: 'sinun@sahkoposti.fi',
      save: 'Tallenna', emailSaved: 'Kiitos! Vastaamme osoitteeseen {email}.', emailInvalid: 'Tarkista sähköpostiosoite.',
      closed: 'Keskustelu on päättynyt. Kirjoita uudelleen, jos sinulla on lisää kysyttävää.', connecting: 'Yhdistetään…',
      failed: 'Lähetys epäonnistui. Yritetään uudelleen…', rateLimited: 'Lähetät liian nopeasti. Odota hetki.', tooLong: 'Viesti on liian pitkä.',
    },
    da: {
      title: 'Chat med os', placeholder: 'Skriv en besked…', send: 'Send', online: 'Vi er online',
      offline: 'Efterlad en besked – vi svarer på e-mail', open: 'Åbn chatten', close: 'Luk chatten',
      greeting: 'Hej! Hvordan kan vi hjælpe?', translated: 'Beskeder oversættes automatisk.',
      emailPrompt: 'Skriv din e-mail, så vi kan svare, selv hvis du forlader siden.', emailPlaceholder: 'din@email.dk',
      save: 'Gem', emailSaved: 'Tak! Vi svarer til {email}.', emailInvalid: 'Tjek e-mailadressen.',
      closed: 'Samtalen er afsluttet. Skriv igen, hvis du har flere spørgsmål.', connecting: 'Forbinder…',
      failed: 'Kunne ikke sende. Prøver igen…', rateLimited: 'Du sender for hurtigt. Vent et øjeblik.', tooLong: 'Beskeden er for lang.',
    },
    en: {
      title: 'Chat with us', placeholder: 'Write a message…', send: 'Send', online: 'We are online',
      offline: 'Leave a message – we will reply by e-mail', open: 'Open chat', close: 'Close chat',
      greeting: 'Hi! How can we help you?', translated: 'Messages are translated automatically.',
      emailPrompt: 'Enter your e-mail so we can reply even if you leave the page.', emailPlaceholder: 'you@example.com',
      save: 'Save', emailSaved: 'Thanks! We will reply to {email}.', emailInvalid: 'Please check the e-mail address.',
      closed: 'This conversation has ended. Write again if you have more questions.', connecting: 'Connecting…',
      failed: 'Could not send. Retrying…', rateLimited: 'You are sending too fast. Please wait a moment.', tooLong: 'The message is too long.',
    },
  };

  // ------------------------------------------------------------------ depolama
  var mem = {};
  function store(kind) {
    return {
      get: function (k) {
        try { return window[kind].getItem(k); } catch (e) { return mem[kind + k] || null; }
      },
      set: function (k, v) {
        try { window[kind].setItem(k, v); } catch (e) { mem[kind + k] = v; }
      },
    };
  }
  var local = store('localStorage');
  var session = store('sessionStorage');
  var VID_KEY = 'spicychat:vid:' + SITE;

  // ------------------------------------------------------------------ durum
  var state = {
    vid: local.get(VID_KEY),
    lang: 'en',
    t: I18N.en,
    online: true,
    open: session.get('spicychat:open') === '1',
    emailKnown: false,
    closed: false,
    connected: false,
    unread: 0,
    pending: [], // gönderilmeyi bekleyen {cid, text, page}
    seen: {},
    askedEmail: false,
  };
  var ws = null;
  var retry = 0;
  var retryTimer = null;

  function pickLang(defaultLang) {
    var forced = (script.dataset.lang || '').toLowerCase();
    if (I18N[forced]) return forced;
    var nav = (navigator.language || '').toLowerCase().split('-')[0];
    if (nav === 'sv' || nav === 'fi' || nav === 'da') return nav;
    return I18N[defaultLang] ? defaultLang : 'en';
  }

  // ------------------------------------------------------------------ arayüz
  var host = document.createElement('div');
  host.id = 'spicy-chat-root';
  var root = host.attachShadow({ mode: 'open' });

  function css(brand) {
    return (
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
      '.wrap{position:fixed;bottom:20px;' + POSITION + ':20px;z-index:2147483000;--b:' + brand + '}' +
      '.launcher{width:60px;height:60px;border-radius:50%;border:0;background:var(--b);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;position:relative;transition:transform .15s}' +
      '.launcher:hover{transform:scale(1.05)}.launcher:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 6px var(--b)}' +
      '.badge{position:absolute;top:-2px;right:-2px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#E4572E;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center}' +
      '.panel{position:absolute;bottom:76px;' + POSITION + ':0;width:370px;height:560px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}' +
      '.wrap.open .panel{display:flex}' +
      '.head{background:var(--b);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}' +
      '.head h2{margin:0;font-size:16px;font-weight:700;line-height:1.2}.status{font-size:12px;opacity:.92;display:flex;align-items:center;gap:6px;margin-top:2px}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:#7CF3C4}.off .dot{background:#F5C26B}' +
      '.x{margin-left:auto;background:transparent;border:0;color:#fff;cursor:pointer;width:32px;height:32px;border-radius:8px;font-size:22px;line-height:1}.x:hover{background:rgba(255,255,255,.15)}' +
      '.log{flex:1;overflow-y:auto;padding:16px;background:#F6F8F8;display:flex;flex-direction:column;gap:8px}' +
      '.msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}' +
      '.msg a{color:inherit;text-decoration:underline}' +
      '.in{align-self:flex-end;background:var(--b);color:#fff;border-bottom-right-radius:4px}' +
      '.out{align-self:flex-start;background:#fff;color:#1d2b2a;border:1px solid #E1E8E7;border-bottom-left-radius:4px}' +
      '.who{display:block;font-size:11px;font-weight:700;opacity:.65;margin-bottom:2px}' +
      '.time{display:block;font-size:10px;opacity:.6;margin-top:3px;text-align:right}' +
      '.pending{opacity:.6}.failed{outline:1px dashed #E4572E}' +
      '.sys{align-self:center;font-size:12px;color:#5a6b69;text-align:center;padding:4px 8px;max-width:90%}' +
      '.mail{background:#fff;border:1px solid #E1E8E7;border-radius:12px;padding:12px;font-size:13px;color:#1d2b2a;display:flex;flex-direction:column;gap:8px;align-self:stretch}' +
      '.mail form{display:flex;gap:6px}.mail input[type=email]{flex:1;min-width:0;padding:8px 10px;border:1px solid #C9D6D4;border-radius:8px;font-size:14px}' +
      '.mail button{padding:8px 12px;border:0;border-radius:8px;background:var(--b);color:#fff;font-weight:600;cursor:pointer}' +
      '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}' +
      '.err{color:#B3261E;font-size:12px}' +
      '.compose{display:flex;gap:8px;padding:10px;border-top:1px solid #E1E8E7;background:#fff;align-items:flex-end}' +
      'textarea{flex:1;resize:none;border:1px solid #C9D6D4;border-radius:10px;padding:9px 11px;font-size:14px;line-height:1.35;max-height:120px;min-height:40px;outline:none;color:#1d2b2a}' +
      'textarea:focus{border-color:var(--b);box-shadow:0 0 0 2px rgba(0,0,0,.04)}' +
      '.send{height:40px;padding:0 14px;border:0;border-radius:10px;background:var(--b);color:#fff;font-weight:600;cursor:pointer;font-size:14px}.send:disabled{opacity:.5;cursor:default}' +
      '.foot{font-size:11px;color:#6b7c7a;text-align:center;padding:0 10px 8px;background:#fff}' +
      '.banner{font-size:12px;text-align:center;padding:6px;background:#FFF4D6;color:#5c4400;display:none}' +
      '@media (max-width:480px){.wrap{bottom:14px;' + POSITION + ':14px}.panel{position:fixed;inset:0;width:100%;height:100%;max-height:none;border-radius:0}.wrap.open .launcher{display:none}}' +
      '@media (prefers-reduced-motion:reduce){.launcher{transition:none}}'
    );
  }

  var ICON_CHAT = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5v-8Z" fill="currentColor"/></svg>';
  var ICON_CLOSE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  var el = {};
  function build(brand, siteName) {
    var style = document.createElement('style');
    style.textContent = css(brand);
    root.appendChild(style);
    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML =
      '<div class="panel" role="dialog" aria-modal="false">' +
      '<div class="head"><div><h2></h2><div class="status"><span class="dot"></span><span class="st"></span></div></div>' +
      '<button class="x" type="button">×</button></div>' +
      '<div class="banner" role="status"></div>' +
      '<div class="log" role="log" aria-live="polite"></div>' +
      '<div class="compose"><textarea rows="1"></textarea><button class="send" type="button"></button></div>' +
      '<div class="foot"></div>' +
      '</div>' +
      '<button class="launcher" type="button">' + ICON_CHAT + '<span class="badge"></span></button>';
    root.appendChild(wrap);
    el.wrap = wrap;
    el.panel = wrap.querySelector('.panel');
    el.title = wrap.querySelector('h2');
    el.status = wrap.querySelector('.status');
    el.st = wrap.querySelector('.st');
    el.x = wrap.querySelector('.x');
    el.log = wrap.querySelector('.log');
    el.input = wrap.querySelector('textarea');
    el.send = wrap.querySelector('.send');
    el.foot = wrap.querySelector('.foot');
    el.banner = wrap.querySelector('.banner');
    el.launcher = wrap.querySelector('.launcher');
    el.badge = wrap.querySelector('.badge');

    var t = state.t;
    el.title.textContent = t.title;
    el.panel.setAttribute('aria-label', t.title + (siteName ? ' – ' + siteName : ''));
    el.input.placeholder = t.placeholder;
    el.input.setAttribute('aria-label', t.placeholder);
    el.input.maxLength = 2000;
    el.send.textContent = t.send;
    el.foot.textContent = t.translated;
    el.x.setAttribute('aria-label', t.close);
    el.launcher.setAttribute('aria-label', t.open);

    el.launcher.addEventListener('click', function () { setOpen(!state.open); });
    el.x.addEventListener('click', function () { setOpen(false); });
    el.send.addEventListener('click', submit);
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    el.input.addEventListener('input', autosize);
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) {
        setOpen(false);
        el.launcher.focus();
      }
    });

    addSystem(t.greeting, 'greeting');
    renderStatus();
    if (state.open) setOpen(true);
  }

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
  }

  function setOpen(open) {
    state.open = open;
    session.set('spicychat:open', open ? '1' : '0');
    el.wrap.classList.toggle('open', open);
    el.launcher.innerHTML = (open ? ICON_CLOSE : ICON_CHAT) + '<span class="badge"></span>';
    el.badge = el.launcher.querySelector('.badge');
    el.launcher.setAttribute('aria-label', open ? state.t.close : state.t.open);
    el.launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      state.unread = 0;
      connect();
      setTimeout(function () { el.input.focus(); scrollDown(); }, 30);
    }
    renderBadge();
  }

  function renderBadge() {
    if (!el.badge) return;
    el.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    el.badge.style.display = state.unread > 0 && !state.open ? 'flex' : 'none';
  }

  function renderStatus() {
    el.st.textContent = state.online ? state.t.online : state.t.offline;
    el.status.classList.toggle('off', !state.online);
  }

  function banner(text) {
    el.banner.textContent = text || '';
    el.banner.style.display = text ? 'block' : 'none';
  }

  function scrollDown() {
    el.log.scrollTop = el.log.scrollHeight;
  }

  function fmtTime(d) {
    try {
      return new Date(d).toLocaleTimeString(state.lang, { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function linkify(node, text) {
    var re = /(https?:\/\/[^\s<>"]+)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.href = m[1];
      a.textContent = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      node.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function addMessage(m, opts) {
    opts = opts || {};
    if (m.id && state.seen[m.id]) return null;
    if (m.id) state.seen[m.id] = true;
    if (m.dir === 'system') {
      if (m.code === 'closed') {
        state.closed = true;
        addSystem(state.t.closed);
      } else if (m.code === 'ask_email' && !opts.history) {
        showEmailForm(true);
      }
      return null;
    }
    var div = document.createElement('div');
    div.className = 'msg ' + (m.dir === 'in' ? 'in' : 'out');
    if (m.dir === 'out' && m.author) {
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.author;
      div.appendChild(who);
    }
    var body = document.createElement('span');
    linkify(body, m.text || '');
    div.appendChild(body);
    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = m.createdAt ? fmtTime(m.createdAt) : '';
    div.appendChild(time);
    if (opts.pending) div.classList.add('pending');
    el.log.appendChild(div);
    if (m.dir === 'out') state.closed = false;
    if (m.dir === 'out' && !opts.history && !state.open) {
      state.unread++;
      renderBadge();
    }
    scrollDown();
    return div;
  }

  function addSystem(text, cls) {
    var div = document.createElement('div');
    div.className = cls === 'greeting' ? 'msg out' : 'sys';
    div.textContent = text;
    el.log.appendChild(div);
    scrollDown();
    return div;
  }

  var mailBox = null;
  function showEmailForm(force) {
    if (state.emailKnown && !force) return;
    if (mailBox) {
      el.log.appendChild(mailBox);
      scrollDown();
      return;
    }
    var t = state.t;
    mailBox = document.createElement('div');
    mailBox.className = 'mail';
    var p = document.createElement('div');
    p.textContent = t.emailPrompt;
    var form = document.createElement('form');
    form.noValidate = true;
    var input = document.createElement('input');
    input.type = 'email';
    input.required = true;
    input.autocomplete = 'email';
    input.placeholder = t.emailPlaceholder;
    input.setAttribute('aria-label', t.emailPlaceholder);
    var hp = document.createElement('input');
    hp.type = 'text';
    hp.className = 'hp';
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.setAttribute('aria-hidden', 'true');
    hp.name = 'website';
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = t.save;
    var err = document.createElement('div');
    err.className = 'err';
    err.setAttribute('role', 'alert');
    form.appendChild(input);
    form.appendChild(hp);
    form.appendChild(btn);
    mailBox.appendChild(p);
    mailBox.appendChild(form);
    mailBox.appendChild(err);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
        err.textContent = t.emailInvalid;
        return;
      }
      err.textContent = '';
      btn.disabled = true;
      sendRaw({ t: 'email', email: v, hp: hp.value });
    });
    mailBox._err = err;
    mailBox._btn = btn;
    el.log.appendChild(mailBox);
    scrollDown();
  }

  // ------------------------------------------------------------------ bağlantı
  function page() {
    return { url: location.href, title: document.title };
  }

  function sendRaw(obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function submit() {
    var text = el.input.value.trim();
    if (!text) return;
    if (text.length > 2000) {
      banner(state.t.tooLong);
      return;
    }
    var cid = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var item = { cid: cid, text: text, page: page() };
    item.node = addMessage({ dir: 'in', text: text }, { pending: true });
    state.pending.push(item);
    el.input.value = '';
    autosize();
    connect();
    flush();
  }

  function flush() {
    if (!state.connected) return;
    for (var i = 0; i < state.pending.length; i++) {
      var p = state.pending[i];
      if (!p.sent) {
        p.sent = sendRaw({ t: 'msg', cid: p.cid, text: p.text, page: p.page });
      }
    }
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    clearTimeout(retryTimer);
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    if (retry > 0) banner(state.t.connecting);
    ws.onopen = function () {
      sendRaw({ t: 'hello', vid: state.vid, lang: navigator.language, page: page() });
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = function () {
      state.connected = false;
      for (var i = 0; i < state.pending.length; i++) state.pending[i].sent = false;
      scheduleReconnect();
    };
    ws.onerror = function () {
      /* onclose takip eder */
    };
  }

  function scheduleReconnect() {
    retry++;
    var delay = Math.min(15000, 1000 * Math.pow(2, Math.min(retry - 1, 4)));
    if (state.open || state.pending.length) banner(state.t.connecting);
    retryTimer = setTimeout(connect, delay);
  }

  function handle(msg) {
    var t = state.t;
    switch (msg.t) {
      case 'welcome': {
        retry = 0;
        banner('');
        state.connected = true;
        state.vid = msg.vid;
        local.set(VID_KEY, msg.vid);
        state.online = msg.online;
        state.emailKnown = msg.emailKnown;
        state.closed = msg.closed;
        renderStatus();
        var msgs = msg.messages || [];
        for (var i = 0; i < msgs.length; i++) addMessage(msgs[i], { history: true });
        flush();
        break;
      }
      case 'ack': {
        for (var j = 0; j < state.pending.length; j++) {
          if (state.pending[j].cid === msg.cid) {
            var p = state.pending.splice(j, 1)[0];
            if (p.node) {
              p.node.classList.remove('pending', 'failed');
              var tm = p.node.querySelector('.time');
              if (tm && msg.m) tm.textContent = fmtTime(msg.m.createdAt);
            }
            if (msg.m && msg.m.id) state.seen[msg.m.id] = true;
            break;
          }
        }
        if (!state.online && !state.emailKnown && !state.askedEmail) {
          state.askedEmail = true;
          showEmailForm();
        }
        break;
      }
      case 'msg':
        if (msg.m) {
          if (msg.echo && msg.m.dir === 'in') addMessage(msg.m);
          else addMessage(msg.m);
        }
        break;
      case 'status':
        state.online = msg.online;
        renderStatus();
        break;
      case 'email_ok':
        state.emailKnown = true;
        if (mailBox) {
          var done = document.createElement('div');
          done.className = 'sys';
          done.textContent = msg.email ? t.emailSaved.replace('{email}', msg.email) : t.emailSaved.replace(' {email}', '').replace('{email}', '');
          mailBox.replaceWith(done);
          mailBox = null;
        }
        break;
      case 'error':
        if (msg.code === 'invalid_email' && mailBox) {
          mailBox._err.textContent = t.emailInvalid;
          mailBox._btn.disabled = false;
        } else if (msg.ref) {
          for (var k = 0; k < state.pending.length; k++) {
            if (state.pending[k].cid === msg.ref) {
              var f = state.pending.splice(k, 1)[0];
              if (f.node) f.node.classList.add('failed');
              banner(msg.code === 'rate_limited' ? t.rateLimited : msg.code === 'too_long' ? t.tooLong : t.failed);
              setTimeout(function () { banner(''); }, 4000);
              break;
            }
          }
        } else if (msg.code === 'hello_first') {
          sendRaw({ t: 'hello', vid: state.vid, lang: navigator.language, page: page() });
        }
        break;
    }
  }

  // ------------------------------------------------------------------ başlat
  function init(cfg) {
    var site = (cfg && cfg.site) || {};
    state.lang = pickLang(site.defaultLang || 'en');
    state.t = I18N[state.lang];
    if (cfg && typeof cfg.online === 'boolean') state.online = cfg.online;
    document.body.appendChild(host);
    build(site.brandColor || '#0F766E', site.name);
    // Daha önce yazışmış ziyaretçiye gelen cevapları kaçırmasın diye hemen bağlan
    if (state.vid || state.open) connect();
  }

  function start() {
    fetch(BASE + '/api/widget/config?site=' + encodeURIComponent(SITE), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(init);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
