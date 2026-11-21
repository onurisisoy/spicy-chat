const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Çeviride değişmemesi gereken kalıplar: adres, e-posta, rezervasyon no. */
export const PROTECTED_PATTERNS = [
  /https?:\/\/[^\s<>"]+/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b[A-Z]{2,4}-?\d{4,}\b/g,
];

/** Metinde geçen sözlük terimlerini döndürür (büyük/küçük harf duyarsız). */
export function findTerms(text, keep = []) {
  const lower = String(text).toLowerCase();
  return keep.filter((t) => t && lower.includes(String(t).toLowerCase()));
}

/**
 * DeepL için: metni XML'e kaçırır ve korunacak parçaları <x>…</x> içine alır.
 * DeepL'e ignore_tags=x verilir, böylece bu parçalar çevrilmez.
 */
export function protectXml(text, keep = []) {
  const src = String(text);
  const ranges = [];
  const add = (start, end) => {
    if (ranges.some((r) => start < r.end && end > r.start)) return;
    ranges.push({ start, end });
  };
  for (const re of PROTECTED_PATTERNS) {
    for (const m of src.matchAll(new RegExp(re.source, re.flags))) add(m.index, m.index + m[0].length);
  }
  const terms = [...keep].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of src.matchAll(re)) add(m.index, m.index + m[0].length);
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    out += escapeXml(src.slice(pos, r.start)) + '<x>' + escapeXml(src.slice(r.start, r.end)) + '</x>';
    pos = r.end;
  }
  out += escapeXml(src.slice(pos));
  return out;
}

export function unprotectXml(xml) {
  return unescapeXml(String(xml).replace(/<\/?x>/g, ''));
}
