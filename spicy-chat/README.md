# Spicy Chat — çok dilli canlı destek

Bu proje spicytravel.se, .fi ve .dk sitelerinin sağ altına bir chat widget'ı ekler. Müşteri kendi dilinde yazar, ekip Türkçe ya da İngilizce cevaplar. Çeviri iki yönde de otomatik yapılır. Ekip **TourNate tarzı panelden** ya da **Telegram forum grubundan** cevap verebilir. Veriler **MongoDB**'de saklanır.

```
Site (widget.js) ──WSS──▶ Sunucu (Node) ──▶ MongoDB
                              │  ├─▶ Çeviri (mock / Claude / DeepL)
                              │  ├─▶ Telegram forum grubu (her konuşma bir topic)
                              │  └─▶ E-posta (müşteri çevrimdışıysa)
                              └──WS──▶ Panel (/panel)
```

---

## 1. Gereksinimler

- **Node.js 20.19+** (22 LTS önerilir): `node -v`
- MongoDB **5.0+** (6.0+ önerilir). Linux sunucundaki MongoDB kullanılacak.
- İsteğe bağlı: Telegram botu, Anthropic ya da DeepL API anahtarı, SMTP.

---

## 2. Hızlı başlangıç (MongoDB olmadan, 2 dakika)

Önce her şeyin çalıştığını görmek için bellek modunu kullan:

```bash
cd spicy-chat
npm install
npm run dev:memory
```

Ardından:
- Test siteleri: http://localhost:3000/test/
- Panel: http://localhost:3000/panel/ (şifre `.env` → `PANEL_PASSWORD`)

Bir test sitesinden yaz, panelden cevapla. Bu modda veriler bellekte tutulur ve yeniden başlatınca silinir.

---

## 3. MongoDB bağlantısı

Bütün bağlantı ayarları `.env` dosyasında. Uygulama MongoDB'ye **sadece senin verdiğin kullanıcıyla** bağlanır ve sadece `spicychat` veritabanını kullanır.

### 3.1 Linux sunucusunda (bir kez, sen yapacaksın)

**a) Uygulama kullanıcısını oluştur**

`scripts/mongo/create-user.js` içindeki `APP_PASSWORD` değerini değiştir, sonra admin kullanıcınla çalıştır:

```bash
mongosh "mongodb://ADMIN@127.0.0.1:27017/admin" scripts/mongo/create-user.js
```

Bu kullanıcı **sadece `spicychat` veritabanında `readWrite`** yetkisine sahip olur.

**b) `mongod.conf` kontrolü** (`/etc/mongod.conf`)

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1        # dışarı kapalı kalsın; Mac'ten SSH tüneliyle bağlanacağız
security:
  authorization: enabled   # kullanıcı/şifre zorunlu
```

Değiştirdiysen MongoDB'yi yeniden başlat: `sudo systemctl restart mongod`

> 27017 portunu internete açma. Lokal testte SSH tüneli, canlıda ise uygulama aynı sunucuda ya da özel ağda çalışacak.

### 3.2 Mac'inden bağlanmak (lokal test)

**SSH tüneli** aç. Bunu ayrı bir terminalde açık bırak:

```bash
ssh -N -L 27017:127.0.0.1:27017 kullanici@SUNUCU_IP
```

> Mac'inde de MongoDB çalışıyorsa 27017 doludur. O zaman `-L 27018:127.0.0.1:27017` kullan ve `.env`'de `MONGODB_HOSTS=127.0.0.1:27018` yaz.

### 3.3 `.env` ayarları

`.env` dosyası lokal test için hazır geliyor. Sadece şifreyi yazman yeterli:

```ini
DB_DRIVER=mongo
MONGODB_HOSTS=127.0.0.1:27017
MONGODB_USER=spicychat_app
MONGODB_PASSWORD=create-user.js'te-verdigin-sifre
MONGODB_AUTH_SOURCE=spicychat
MONGODB_DB=spicychat
MONGODB_DIRECT_CONNECTION=true
```

Bu parçalardan bağlantı adresi otomatik kurulur ve şifredeki özel karakterler (`@ : / #` gibi) otomatik encode edilir. İstersen tek satırlık `MONGODB_URI=` da yazabilirsin; doluysa parçalar yok sayılır.

**Senaryoya göre örnekler:**

| Durum | Ayar |
|---|---|
| SSH tüneli / tek sunucu | `MONGODB_HOSTS=127.0.0.1:27017`, `MONGODB_DIRECT_CONNECTION=true` |
| Replica set (özel ağ) | `MONGODB_HOSTS=10.0.0.11:27017,10.0.0.12:27017,10.0.0.13:27017`, `MONGODB_REPLICA_SET=rs0`, `MONGODB_DIRECT_CONNECTION=false` |
| Replica set'e SSH tüneliyle | Tüneli **primary**'ye aç, `MONGODB_DIRECT_CONNECTION=true`, `MONGODB_REPLICA_SET=` boş |
| Kullanıcı admin DB'sinde | `MONGODB_AUTH_SOURCE=admin` |
| TLS açık sunucu | `MONGODB_TLS=true`, gerekirse `MONGODB_TLS_CA_FILE=/yol/ca.pem` |
| Tek sunucu, replica set yok | `MONGODB_WRITE_CONCERN=1` |

Diğer ayarlar (pool boyutu, zaman aşımları, retryWrites) `.env.example` içinde açıklamalı.

### 3.4 Kontrol ve index'ler

```bash
npm run config:check   # .env'i doğrular, hiçbir yere bağlanmaz
npm run db:check       # bağlanır, kullanıcıyı/rolleri/index'leri kontrol eder; HİÇBİR ŞEY YAZMAZ
npm run db:indexes     # koleksiyonları ve index'leri oluşturur (bir kez; veritabanına yazar)
npm run dev            # uygulamayı MongoDB ile başlatır
```

Uygulama açılışta index oluşturmaz (`MONGODB_AUTO_INDEX=false`). Index'leri sen `db:indexes` ile kurarsın.

**Koleksiyonlar:**

| Koleksiyon | İçerik |
|---|---|
| `visitors` | Anonim ziyaretçi id'si, site, dil, e-posta (bırakırsa), son görülme |
| `conversations` | Site, ziyaretçi, müşteri dili, durum, Telegram topic id, sayfa, okunmamış sayısı |
| `messages` | Orijinal metin, tespit edilen dil, çeviri (metin/dil/sağlayıcı/başarı), kanal, yazan |

**Saklama süresi (GDPR):** `.env` içinde `DATA_RETENTION_DAYS=180` gibi bir değer verip `npm run db:indexes` çalıştırırsan MongoDB TTL index'leri kurulur. Eski kayıtlar bu index'lerle otomatik silinir.

**Gerçek MongoDB'ye karşı depo testi (isteğe bağlı):**

```bash
MONGODB_TEST_URI="mongodb://ADMIN:SIFRE@127.0.0.1:27017/?authSource=admin" npm run test:mongo
```

Bu test `spicychat_test_xxxx` adlı geçici bir veritabanı açar ve iş bitince sadece onu siler. Asıl `spicychat` veritabanına dokunmaz.

---

## 4. Çeviri

`.env` → `TRANSLATION_PROVIDER`:

| Değer | Ne zaman |
|---|---|
| `mock` | API anahtarı olmadan test. Metni `[sv→tr] …` diye işaretler, dil tespiti basit tahmin |
| `anthropic` | Önerilen. `ANTHROPIC_API_KEY` gerekir. Model: `ANTHROPIC_MODEL` |
| `deepl` | `DEEPL_API_KEY` gerekir (free anahtar `:fx` ile biter) |

- `TEAM_LANGS=tr,en`: Müşteri bu dillerden birinde yazarsa çeviri yapılmaz.
- `config/glossary.json`: Otel ve bölge adları gibi **çevrilmeyecek** terimler. Rezervasyon numaraları, e-posta ve URL'ler zaten korunur.
- Çeviri API'si çökerse ya da zaman aşımına uğrarsa mesaj **kaybolmaz**: orijinal metin "çevrilemedi" etiketiyle iletilir.

---

## 5. Telegram (isteğe bağlı)

1. Telegram'da **@BotFather** → `/newbot` ile bot oluştur ve token'ı `.env` → `TELEGRAM_BOT_TOKEN` alanına yaz.
2. Yeni bir grup oluştur ve grup ayarlarından **Topics**'i aç.
3. Botu gruba ekle ve **admin** yap. **Manage Topics** yetkisi açık olmalı.
4. Grup id'sini bul: `npm run telegram:check`. Grupta bir mesaj yazdıktan sonra listede görünür, `-100…` ile başlar. Bunu `TELEGRAM_GROUP_ID` alanına yaz.
5. `npm run telegram:check` komutunu tekrar çalıştır, her şey ✔ olmalı. Sonra uygulamayı başlat.

**Grupta kullanım:**
- Her yeni müşteri konuşması için bir topic açılır, adı şöyle olur: `[SV] spicytravel.se · #7A18`.
- Topic'e düz yazdığın mesaj müşteriye kendi dilinde gider. Bot, müşterinin ne gördüğünü `↳ sv: …` diye altına yazar.
- `#not …` yazarsan sadece ekip görür.
- Komutlar: `/eposta` müşteriden e-posta ister, `/kapat` konuşmayı kapatır, `/online`, `/offline`, `/otomatik` durumu ayarlar, `/durum`, `/yardim`, `/chatid`.
- `TELEGRAM_ALLOW_ALL_GROUP_MEMBERS=false` yaparsan sadece `config/agents.json` içinde `telegramUserId` değeri olan kişiler cevap verebilir. Kendi id'ni öğrenmek için bota yaz; yetkin yoksa bot id'ni söyler.

> Aynı bot token'ıyla aynı anda tek bir uygulama çalışabilir. İkincisi açılırsa Telegram 409 hatası verir.

---

## 6. Panel

Adres: `/panel/`. Ekip üyeleri `config/agents.json` dosyasından gelir, giriş için ortak şifre `PANEL_PASSWORD` kullanılır.

- Soldaki listede konuşmalar görünür (Açık / Kapalı / Tümü, site filtresi, okunmamış sayısı).
- Gelen mesajda çeviri büyük yazılır, **Orijinali göster** ile müşterinin kendi metni açılır.
- Giden mesajın altında **müşterinin gördüğü çeviri** yazar.
- **İç not**, **E-posta iste**, **Kapat** ve **Veriyi sil** (GDPR, ziyaretçinin tüm kayıtlarını siler) butonları var.
- Üstteki menüden durum seçilir: Otomatik (çalışma saatleri) / Online / Offline.

İleride bu panel TourNate shell'ine bir modül olarak taşınacak. Kullandığı API'ler: `/api/panel/*` ve `/ws/agent`.

---

## 7. Siteye ekleme

Her siteye tek satır eklenir (canlı adresle):

```html
<script src="https://chat.spicytravel.se/widget.js" data-site="spicytravel-se" async></script>
```

- `data-site` değeri `config/sites.json` içindeki `id` ile aynı olmalı. Sitenin adresi o kaydın `allowedOrigins` listesinde bulunmalı.
- İsteğe bağlı: `data-lang="sv|fi|da|en"`, `data-position="left"`.
- Widget Shadow DOM kullanır, sitenin CSS'iyle çakışmaz.

---

## 8. Çevrimdışı müşteri ve e-posta

- Durum offline iken müşteri ilk mesajını yazınca widget e-posta adresini sorar.
- Ekip cevap yazdığında müşteri sayfada değilse ve e-postası kayıtlıysa, `EMAIL_DEBOUNCE_SECONDS` süresince gelen cevaplar toplanır. Sonra müşterinin dilinde tek bir e-posta olarak gönderilir.
- `SMTP_HOST` boşsa e-posta gönderilmez, `var/outbox/` klasörüne `.eml` dosyası olarak yazılır (lokal test). Bu dosyayı Mail uygulamasıyla açabilirsin.
- Müşteri e-postaya cevap verirse bu cevap sisteme düşmez, `MAIL_REPLY_TO` adresine gider.

---

## 9. Test

```bash
npm test
```

26 test var: birim testleri, uçtan uca akış (widget → panel → cevap → e-posta → kapatma → GDPR silme), sahte Telegram API'siyle topic akışı ve çeviri hatası senaryoları. Bu testler bellek modunda çalışır, MongoDB'ye bağlanmaz.

**Elle test senaryosu:** http://localhost:3000/test/ sayfasındaki adımları izle.

---

## 10. Klasör yapısı

```
config/          sites.json, agents.json, glossary.json
public/          widget.js, panel/, test/ (sahte siteler)
src/
  config.js      .env okuma, doğrulama, Mongo URI kurma
  db/            mongo.js (MongoDB), memory.js (test), indexes.js
  chat/          service.js: sohbetin çekirdeği
  translate/     anthropic / deepl / mock, sözlük koruması
  telegram/      bot (long polling, topic'ler)
  realtime/      WebSocket (widget + panel)
  http/          Express: panel API, widget, statik dosyalar
  email/         SMTP ya da outbox, çok dilli şablon
scripts/         db-check, db-indexes, config-check, telegram-check, mongo/create-user.js
deploy/          canlı için nginx ve systemd örnekleri (şimdilik gerekmez)
test/
```

---

## 11. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `Ayar hataları: …` | Mesajda hangi alanın eksik olduğu yazar. `.env`'i düzelt, `npm run config:check` çalıştır |
| `db:check` → bağlanamadı | SSH tüneli açık mı? Port, şifre ve `authSource` doğru mu? Replica set'e tünelle bağlanıyorsan `directConnection=true` gerekir |
| `Authentication failed` | `MONGODB_AUTH_SOURCE`, kullanıcının oluşturulduğu veritabanıyla aynı olmalı (`spicychat`) |
| Widget görünmüyor / bağlanmıyor | Tarayıcı konsoluna bak. Sitenin adresi `sites.json` → `allowedOrigins` içinde mi? |
| Telegram 409 | Aynı token başka bir yerde çalışıyor. Diğerini kapat |
| Bot topic açmıyor | Bot admin mi, **Manage Topics** yetkisi açık mı? `npm run telegram:check` |
| Port dolu | `.env` → `PORT=3001` |

---

## 12. Ücretsiz sunucuda test (Render + MongoDB Atlas)

Repoda hazır bir `render.yaml` var. Uygulama Render'ın ücretsiz planında çalışır; ücretsiz plan 15 dakika trafik olmazsa uyur ve ilk istek yaklaşık 1 dakika sürer.

1. **GitHub:** Yeni bir **private** repo aç (örn. `spicy-chat`) ve bu klasörü yükle. `.env` dosyası `.gitignore` sayesinde yüklenmez.
2. **MongoDB Atlas (ücretsiz):** cloud.mongodb.com → Free cluster (Frankfurt) → Database Access'te kullanıcı oluştur → Network Access'te `0.0.0.0/0` (sadece test için) → **Connect → Drivers** ekranındaki `mongodb+srv://…` adresini kopyala.
3. **Render:** render.com → GitHub ile giriş → **New → Blueprint** → repoyu seç. Render, `PANEL_PASSWORD` ve diğer gizli değerleri soracak.
   - İlk deneme: `DB_DRIVER=memory` kalsın (veritabanısız).
   - Sonra: Environment'ta `DB_DRIVER=mongo` ve `MONGODB_URI=<Atlas adresi>` gir. Lokalde `.env`'e aynı adresi yazıp bir kez `npm run db:indexes` çalıştır.
4. **Kontrol:** Lokalden çalıştır:
   ```bash
   PANEL_PASSWORD=... npm run smoke -- https://spicy-chat-xxxx.onrender.com
   ```
   Script sağlık kontrolünü, widget'ı, panel girişini, müşteri → ekip → müşteri akışını kontrol eder ve test verisini siler. Tarayıcıda da `/test/` ve `/panel/` adreslerine bakabilirsin.

> Telegram ücretsiz planda da çalışır, ama servis uyuyorken Telegram'dan yazılanlar servis uyanana kadar bekler.

## 13. Canlıya geçerken (sonraki adım)

- `NODE_ENV=production`, güçlü `SESSION_SECRET` ve `PANEL_PASSWORD` kullan, `SERVE_TEST_PAGES=false` yap.
- `sites.json` içindeki `allowedOrigins` listesinden localhost adreslerini çıkar.
- Uygulamayı MongoDB ile aynı sunucuda ya da aynı özel ağda çalıştır. `deploy/` klasöründe nginx (WebSocket ayarlı) ve systemd örnekleri var.
- Çeviri sağlayıcısı ve SMTP servisiyle DPA imzala, sitelerin gizlilik metinlerini güncelle.
