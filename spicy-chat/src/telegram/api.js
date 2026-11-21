export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`Telegram ${method}: ${code} ${description}`);
    this.code = code;
    this.description = description || '';
  }
}

export function createTelegramApi({ token, apiBase }) {
  const base = `${apiBase}/bot${token}`;
  return async function call(method, params = {}, { signal } = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new TelegramError(method, res.status, 'JSON olmayan cevap');
    }
    if (!data.ok) throw new TelegramError(method, data.error_code || res.status, data.description);
    return data.result;
  };
}

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
