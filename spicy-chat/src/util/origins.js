/**
 * Widget'ın hangi sitelerden bağlanabileceğini belirler.
 * - config/sites.json → allowedOrigins (tam eşleşme, "*" = herkes)
 * - sunucunun kendi adresi (test sayfaları buradan sunulur)
 * - canlı ortam dışında: http://localhost:* ve http://127.0.0.1:* (lokal test kolaylığı)
 */
export function isOriginAllowed(cfg, site, origin) {
  if (!origin) return true; // tarayıcı dışı istemci (test, curl)
  const allowed = site.allowedOrigins || [];
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try {
    if (origin === new URL(cfg.publicBaseUrl).origin) return true;
  } catch {
    /* geç */
  }
  if (!cfg.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}
