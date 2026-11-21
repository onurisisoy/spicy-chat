/** Basit kayan pencere sayacı (bellek içi, tek sunucu için yeterli). */
export function createRateLimiter({ limit, windowMs = 60_000 }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, windowMs);
  timer.unref?.();
  return {
    hit(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);
      if (arr.length >= limit) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
