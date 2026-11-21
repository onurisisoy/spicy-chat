(function () {
  'use strict';

  var LANG = { sv: 'İsveççe', fi: 'Fince', da: 'Danca', nb: 'Norveççe', en: 'İngilizce', tr: 'Türkçe', de: 'Almanca' };
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    token: null,
    agent: null,
    status: null,
    filter: 'open',
    site: '',
    sites: {},
    convs: {},
    activeId: null,
    messages: {},
    ws: null,
    retry: 0,
  };

  // ------------------------------------------------------------ depolama
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------ API
  function api(method, url, body) {
    return fetch('/api/panel' + url, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, state.token ? { authorization: 'Bearer ' + state.token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401 && url !== '/login') {
        logout();
        throw new Error('Oturum süresi doldu');
      }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.message || data.error || 'Hata');
        return data;
      });
    });
  }

  // ------------------------------------------------------------ giriş
  function showLogin() {
    $('app').hidden = true;
    $('login').hidden = false;
    api('GET', '/agents').then(function (agents) {
      var sel = $('agentSelect');
      sel.innerHTML = '';
      agents.forEach(function (a) {
        var o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.name;
        sel.appendChild(o);
      });
      var last = ss('panel:lastAgent');
      if (last) sel.value = last;
    });
    $('password').focus();
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('loginError').textContent = '';
    api('POST', '/login', { agentId: $('agentSelect').value, password: $('password').value })
      .then(function (r) {
        state.token = r.token;
        ss('panel:token', r.token);
        ss('panel:lastAgent', r.agent.id);
        $('password').value = '';
        boot();
      })
      .catch(function (err) { $('loginError').textContent = err.message; });
  });

  function logout() {
    state.token = null;
    ss('panel:token', null);
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    showLogin();
  }
  $('logout').addEventListener('click', logout);

  // ------------------------------------------------------------ açılış
  function boot() {
    api('GET', '/me').then(function (r) {
      state.agent = r.agent;
      $('me').textContent = r.agent.name;
      renderStatus(r.status);
      $('login').hidden = true;
      $('app').hidden = false;
      return api('GET', '/sites');
    }).then(function (sites) {
      var sel = $('siteFilter');
      sel.innerHTML = '<option value="">Tüm siteler</option>';
      sites.forEach(function (s) {
        state.sites[s.id] = s;
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.domain || s.name;
        sel.appendChild(o);
      });
      loadList();
      connectWs();
    }).catch(function () {});
  }

  // ------------------------------------------------------------ durum
  function renderStatus(s) {
    state.status = s;
    $('statusMode').value = s.mode;
    $('statusText').textContent = s.online ? 'Online' : 'Offline';
    $('statusDot').className = 'status-dot ' + (s.online ? 'on' : 'off');
  }
  $('statusMode').addEventListener('change', function () {
    api('POST', '/status', { mode: this.value }).then(renderStatus);
  });

  // ------------------------------------------------------------ liste
  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.seg button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.filter = b.dataset.status;
      loadList();
    });
  });
  $('siteFilter').addEventListener('change', function () {
    state.site = this.value;
    loadList();
  });

  function loadList() {
    var q = '?status=' + state.filter + (state.site ? '&site=' + encodeURIComponent(state.site) : '');
    api('GET', '/conversations' + q).then(function (list) {
      state.convs = {};
      list.forEach(function (c) { state.convs[c.id] = c; });
      renderList();
    });
  }

  function visible(c) {
    if (state.filter !== 'all' && c.status !== state.filter) return false;
    if (state.site && c.siteId !== state.site) return false;
    return true;
  }

  function timeLabel(d) {
    var date = new Date(d);
    var today = new Date();
    if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
  }

  function renderList() {
    var ul = $('convList');
    ul.innerHTML = '';
    var list = Object.values(state.convs).filter(visible).sort(function (a, b) { return new Date(b.lastMessageAt) - new Date(a.lastMessageAt); });
    $('emptyList').hidden = list.length > 0;
    var unreadTotal = 0;
    list.forEach(function (c) {
      unreadTotal += c.unreadForAgents || 0;
      var li = document.createElement('li');
      li.className = 'conv' + (c.id === state.activeId ? ' active' : '') + (c.status === 'closed' ? ' closed' : '');
      li.tabIndex = 0;
      var lang = document.createElement('span');
      lang.className = 'lang';
      lang.textContent = (c.visitorLang || '?').toUpperCase();
      var who = document.createElement('span');
      who.className = 'who';
      var site = state.sites[c.siteId];
      who.textContent = (site ? site.domain : c.siteId) + ' · #' + c.visitorId.slice(0, 4).toUpperCase() + (c.visitorEmail ? ' · ' + c.visitorEmail : '');
      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = timeLabel(c.lastMessageAt);
      var prev = document.createElement('span');
      prev.className = 'prev';
      prev.textContent = c.lastMessagePreview || '';
      li.appendChild(lang);
      li.appendChild(who);
      li.appendChild(time);
      li.appendChild(document.createElement('span'));
      li.appendChild(prev);
      if (c.unreadForAgents) {
        var u = document.createElement('span');
        u.className = 'unread';
        u.textContent = c.unreadForAgents;
        li.appendChild(u);
      }
      li.addEventListener('click', function () { openConversation(c.id); });
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter') openConversation(c.id); });
      ul.appendChild(li);
    });
    document.title = (unreadTotal ? '(' + unreadTotal + ') ' : '') + 'Spicy Destek · Panel';
  }

  // ------------------------------------------------------------ konuşma
  function openConversation(id) {
    state.activeId = id;
    renderList();
    api('GET', '/conversations/' + id).then(function (d) {
      state.convs[id] = d.conversation;
      state.messages[id] = d.messages;
      state.visitor = d.visitor;
      renderChat();
      if (d.conversation.unreadForAgents) api('POST', '/conversations/' + id + '/read').catch(function () {});
    });
  }

  function renderChat() {
    var c = state.convs[state.activeId];
    if (!c) return;
    $('placeholder').hidden = true;
    $('chatView').hidden = false;
    var site = state.sites[c.siteId];
    $('cLang').textContent = (c.visitorLang || '?').toUpperCase();
    $('cSite').textContent = site ? site.name : c.siteId;
    $('cVisitor').textContent = '· Ziyaretçi #' + c.visitorId.slice(0, 4).toUpperCase() + (c.status === 'closed' ? ' · kapalı' : '');
    var page = $('cPage');
    if (c.pageUrl) {
      page.href = /^https?:\/\//.test(c.pageUrl) ? c.pageUrl : '#';
      page.textContent = c.pageTitle || c.pageUrl;
    } else {
      page.removeAttribute('href');
      page.textContent = '';
    }
    $('cEmail').textContent = c.visitorEmail ? '· ' + c.visitorEmail : '';
    $('closeConv').disabled = c.status === 'closed';
    $('sendHint').textContent = 'Müşteriye ' + (LANG[c.visitorLang] || c.visitorLang) + ' gider';
    var box = $('messages');
    box.innerHTML = '';
    (state.messages[c.id] || []).forEach(function (m) { box.appendChild(renderMessage(m)); });
    box.scrollTop = box.scrollHeight;
    disarmDelete();
  }

  function fmt(d) {
    return new Date(d).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  var SYS = {
    closed: function (m) { return 'Konuşma kapatıldı' + (m.author && m.author.name ? ' (' + m.author.name + ')' : ''); },
    ask_email: function (m) { return 'Müşteriden e-posta istendi' + (m.author && m.author.name ? ' (' + m.author.name + ')' : ''); },
    email_set: function (m) { return 'Müşteri e-posta bıraktı: ' + ((m.meta && m.meta.email) || ''); },
    email_sent: function (m) { return 'Müşteri çevrimdışıydı, cevap e-postayla gönderildi → ' + ((m.meta && m.meta.to) || ''); },
  };

  function renderMessage(m) {
    if (m.direction === 'system') {
      var s = document.createElement('div');
      s.className = 'sys';
      s.textContent = (SYS[m.text] ? SYS[m.text](m) : m.text) + ' · ' + fmt(m.createdAt);
      return s;
    }
    var div = document.createElement('div');
    div.className = 'm ' + m.direction;
    var meta = document.createElement('div');
    meta.className = 'meta';
    var channel = m.channel === 'telegram' ? ' · Telegram' : m.channel === 'panel' ? ' · panel' : '';
    if (m.direction === 'in') meta.textContent = 'Müşteri (' + (LANG[m.lang] || m.lang || '?') + ') · ' + fmt(m.createdAt);
    else if (m.direction === 'note') meta.textContent = 'İç not · ' + (m.author && m.author.name) + channel + ' · ' + fmt(m.createdAt);
    else meta.textContent = (m.author && m.author.name) + channel + ' · ' + fmt(m.createdAt);
    div.appendChild(meta);

    var t = m.translation;
    var main = document.createElement('div');
    if (m.direction === 'in' && t && t.translated) main.textContent = t.text;
    else main.textContent = m.text;
    div.appendChild(main);

    if (t && t.ok === false) {
      var flag = document.createElement('div');
      flag.className = 'flag';
      flag.textContent = m.direction === 'in' ? 'Çevrilemedi, orijinal metin' : 'Çevrilemedi, müşteriye orijinal metin gitti';
      div.appendChild(flag);
    }
    if (m.direction === 'in' && t && t.translated) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toggle';
      btn.textContent = 'Orijinali göster';
      var orig = document.createElement('div');
      orig.className = 'orig';
      orig.textContent = m.text;
      orig.hidden = true;
      btn.addEventListener('click', function () {
        orig.hidden = !orig.hidden;
        btn.textContent = orig.hidden ? 'Orijinali göster' : 'Orijinali gizle';
      });
      div.appendChild(btn);
      div.appendChild(orig);
    }
    if (m.direction === 'out' && t && t.translated) {
      var sent = document.createElement('div');
      sent.className = 'sent';
      sent.textContent = 'Müşteri gördü (' + (LANG[t.lang] || t.lang) + '): ' + t.text;
      div.appendChild(sent);
    }
    return div;
  }

  // ------------------------------------------------------------ gönderme
  var composer = $('composer');
  $('noteMode').addEventListener('change', function () {
    composer.classList.toggle('note-mode', this.checked);
    $('sendBtn').textContent = this.checked ? 'Not ekle' : 'Gönder';
  });
  $('reply').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('reply').value.trim();
    if (!text || !state.activeId) return;
    $('sendBtn').disabled = true;
    api('POST', '/conversations/' + state.activeId + '/messages', { text: text, note: $('noteMode').checked })
      .then(function () {
        $('reply').value = '';
        if ($('noteMode').checked) {
          $('noteMode').checked = false;
          $('noteMode').dispatchEvent(new Event('change'));
        }
      })
      .catch(function (err) { alertInline(err.message); })
      .finally(function () {
        $('sendBtn').disabled = false;
        $('reply').focus();
      });
  });

  function alertInline(text) {
    var s = document.createElement('div');
    s.className = 'sys';
    s.style.color = '#B3261E';
    s.textContent = text;
    $('messages').appendChild(s);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  $('askEmail').addEventListener('click', function () {
    api('POST', '/conversations/' + state.activeId + '/ask-email').catch(function (e) { alertInline(e.message); });
  });
  $('closeConv').addEventListener('click', function () {
    api('POST', '/conversations/' + state.activeId + '/close').catch(function (e) { alertInline(e.message); });
  });

  var delBtn = $('deleteVisitor');
  function disarmDelete() {
    delBtn.classList.remove('armed');
    delBtn.textContent = 'Veriyi sil';
  }
  delBtn.addEventListener('click', function () {
    var c = state.convs[state.activeId];
    if (!c) return;
    if (!delBtn.classList.contains('armed')) {
      delBtn.classList.add('armed');
      delBtn.textContent = 'Emin misin? Tüm konuşmalar silinir';
      setTimeout(disarmDelete, 5000);
      return;
    }
    api('DELETE', '/visitors/' + c.visitorId).then(function () {
      Object.keys(state.convs).forEach(function (id) { if (state.convs[id].visitorId === c.visitorId) delete state.convs[id]; });
      state.activeId = null;
      $('chatView').hidden = true;
      $('placeholder').hidden = false;
      renderList();
    }).catch(function (e) { alertInline(e.message); });
  });

  // ------------------------------------------------------------ canlı bağlantı
  function connectWs() {
    var url = location.origin.replace(/^http/, 'ws') + '/ws/agent?token=' + encodeURIComponent(state.token);
    var ws = new WebSocket(url);
    state.ws = ws;
    ws.onopen = function () {
      var reconnected = state.retry > 0;
      state.retry = 0;
      $('conn').classList.add('live');
      $('conn').title = 'Canlı bağlantı açık';
      if (reconnected) loadList();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'conv') {
        state.convs[msg.c.id] = msg.c;
        renderList();
        if (msg.c.id === state.activeId) renderChatHeaderOnly(msg.c);
      } else if (msg.t === 'msg') {
        state.convs[msg.c.id] = msg.c;
        var list = state.messages[msg.c.id];
        if (list && !list.some(function (x) { return x.id === msg.m.id; })) list.push(msg.m);
        if (msg.c.id === state.activeId) {
          var box = $('messages');
          var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
          box.appendChild(renderMessage(msg.m));
          if (atBottom || msg.m.direction !== 'in') box.scrollTop = box.scrollHeight;
          if (msg.m.direction === 'in' && document.visibilityState === 'visible') {
            api('POST', '/conversations/' + msg.c.id + '/read').catch(function () {});
          }
        }
        renderList();
      } else if (msg.t === 'status' || msg.t === 'hello') {
        renderStatus(msg.status);
      }
    };
    ws.onclose = function (ev) {
      $('conn').classList.remove('live');
      $('conn').title = 'Bağlantı koptu, yeniden deneniyor';
      if (!state.token) return;
      state.retry++;
      setTimeout(connectWs, Math.min(15000, 1000 * Math.pow(2, Math.min(state.retry, 4))));
    };
  }

  function renderChatHeaderOnly(c) {
    $('cVisitor').textContent = '· Ziyaretçi #' + c.visitorId.slice(0, 4).toUpperCase() + (c.status === 'closed' ? ' · kapalı' : '');
    $('cEmail').textContent = c.visitorEmail ? '· ' + c.visitorEmail : '';
    $('cLang').textContent = (c.visitorLang || '?').toUpperCase();
    $('closeConv').disabled = c.status === 'closed';
    $('sendHint').textContent = 'Müşteriye ' + (LANG[c.visitorLang] || c.visitorLang) + ' gider';
  }

  document.addEventListener('visibilitychange', function () {
    var c = state.convs[state.activeId];
    if (document.visibilityState === 'visible' && c && c.unreadForAgents) api('POST', '/conversations/' + c.id + '/read').catch(function () {});
  });

  // ------------------------------------------------------------ başla
  state.token = ss('panel:token');
  if (state.token) boot();
  else showLogin();
})();
