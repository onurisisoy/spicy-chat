export const LANG_NAMES = {
  sv: 'Swedish',
  fi: 'Finnish',
  da: 'Danish',
  nb: 'Norwegian',
  en: 'English',
  tr: 'Turkish',
  de: 'German',
};

export const LANG_LABELS_TR = {
  sv: 'İsveççe',
  fi: 'Fince',
  da: 'Danca',
  nb: 'Norveççe',
  en: 'İngilizce',
  tr: 'Türkçe',
  de: 'Almanca',
};

export function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  if (c === 'no' || c === 'nn') return 'nb';
  return /^[a-z]{2}$/.test(c) ? c : null;
}

const RULES = {
  tr: { chars: /[ğşıİĞŞ]/g, words: ['merhaba', 'teşekkür', 'teşekkürler', 'evet', 'hayır', 'lütfen', 'için', 'bir', 've', 'bu', 'ne', 'mı', 'mi', 'var', 'yok', 'nasıl', 'otel', 'tarih'] },
  da: { chars: /[æøÆØ]/g, words: ['jeg', 'ikke', 'hvad', 'hvordan', 'tak', 'og', 'det', 'er', 'har', 'kan', 'vil', 'med', 'hej', 'der', 'en', 'til', 'på', 'af'] },
  sv: { chars: /[åÅ]/g, words: ['jag', 'inte', 'och', 'det', 'är', 'har', 'kan', 'hur', 'vad', 'tack', 'hej', 'finns', 'plats', 'den', 'för', 'med', 'till', 'på', 'av', 'vi'] },
  fi: { chars: /(aa|ee|ii|oo|uu|yy|ää|öö)/g, words: ['ja', 'on', 'ei', 'minä', 'kiitos', 'hei', 'onko', 'mitä', 'miten', 'voin', 'haluan', 'meillä', 'teillä', 'hotelli', 'kyllä', 'paljonko', 'tilaa'] },
  en: { chars: null, words: ['the', 'and', 'is', 'are', 'hello', 'hi', 'thanks', 'thank', 'can', 'have', 'what', 'how', 'please', 'there', 'you', 'we', 'room', 'available'] },
};

/** Kaba dil tahmini: mock sağlayıcı ve API hatasında yedek olarak kullanılır. */
export function guessLang(text, fallback = 'en') {
  const lower = ` ${String(text).toLowerCase().replace(/[^\p{L}\s]/gu, ' ')} `;
  let best = null;
  let bestScore = 0;
  for (const [lang, r] of Object.entries(RULES)) {
    let score = 0;
    if (r.chars) score += (String(text).match(r.chars) || []).length * 1.5;
    for (const w of r.words) if (lower.includes(` ${w} `)) score += 2;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : fallback;
}
