const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * "mon-fri 09:00-18:00;sat 10:00-14:00" biçimini kurallara çevirir.
 */
export function parseHours(spec) {
  const rules = [];
  for (const part of String(spec || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/i);
    if (!m) throw new Error(`SUPPORT_HOURS anlaşılamadı: "${part}"`);
    const from = DAYS.indexOf(m[1].toLowerCase());
    const to = DAYS.indexOf((m[2] || m[1]).toLowerCase());
    if (from < 0 || to < 0) throw new Error(`SUPPORT_HOURS gün adı hatalı: "${part}"`);
    const days = [];
    for (let d = from; ; d = (d + 1) % 7) {
      days.push(d);
      if (d === to) break;
    }
    rules.push({ days, start: Number(m[3]) * 60 + Number(m[4]), end: Number(m[5]) * 60 + Number(m[6]) });
  }
  return rules;
}

export function isWithinHours(rules, timezone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return rules.some((r) => r.days.includes(day) && minutes >= r.start && minutes < r.end);
}

/** Online durumu: elle ayar (online/offline) çalışma saatlerini ezer; "auto" saatlere bakar. */
export function createPresence({ hours, timezone }) {
  const rules = parseHours(hours);
  let mode = 'auto';
  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      if (!['auto', 'online', 'offline'].includes(next)) throw new Error('mode auto/online/offline olmalı');
      mode = next;
    },
    isOnline(date = new Date()) {
      if (mode === 'online') return true;
      if (mode === 'offline') return false;
      return isWithinHours(rules, timezone, date);
    },
  };
}
