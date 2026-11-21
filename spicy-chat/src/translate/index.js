import { anthropicProvider, deeplProvider, mockProvider } from './providers.js';
import { guessLang } from './langs.js';

/**
 * Çeviri servisi. ASLA fırlatmaz: hata olursa orijinal metni ok:false ile döner,
 * böylece mesaj kaybolmaz, sadece "çevrilemedi" diye işaretlenir.
 */
export function createTranslator(cfg, log, { provider: injected } = {}) {
  const t = cfg.translation;
  const provider =
    injected ||
    (t.provider === 'anthropic'
      ? anthropicProvider(t.anthropic)
      : t.provider === 'deepl'
        ? deeplProvider(t.deepl)
        : mockProvider());
  const glossary = cfg.glossary?.keep || [];

  async function translate({ text, to, skipIfIn = [], hintLang }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), t.timeoutMs);
    const started = Date.now();
    try {
      const r = await provider.translate({ text, to, skipIfIn, hintLang, glossary, signal: controller.signal });
      log.debug(`${provider.name}: ${r.detectedLang}→${to} ${r.translated ? 'çevrildi' : 'gerek yok'} (${Date.now() - started} ms)`);
      return { ok: true, provider: provider.name, ...r, to };
    } catch (e) {
      const reason = e.name === 'AbortError' ? `zaman aşımı (${t.timeoutMs} ms)` : e.message;
      log.warn(`Çeviri başarısız, orijinal iletiliyor: ${reason}`);
      return {
        ok: false,
        provider: provider.name,
        text,
        detectedLang: guessLang(text, hintLang || 'en'),
        translated: false,
        to,
        error: reason,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { provider: provider.name, translate };
}
