// =====================================================================
//  Uygulama kullanıcısını oluşturur. Linux sunucusunda admin olarak çalıştır:
//
//    mongosh "mongodb://ADMIN_KULLANICI@127.0.0.1:27017/admin" scripts/mongo/create-user.js
//
//  Çalıştırmadan önce aşağıdaki iki değeri değiştir.
//  Kullanıcı sadece "spicychat" veritabanında readWrite yetkisine sahip olur.
// =====================================================================

const DB_NAME = 'spicychat';
const APP_USER = 'spicychat_app';
const APP_PASSWORD = 'BURAYA-GUCLU-BIR-SIFRE'; // .env → MONGODB_PASSWORD

if (APP_PASSWORD.startsWith('BURAYA')) {
  throw new Error('Önce APP_PASSWORD değerini değiştir.');
}

const target = db.getSiblingDB(DB_NAME);
if (target.getUser(APP_USER)) {
  print(`"${APP_USER}" zaten var, şifre ve roller güncelleniyor.`);
  target.updateUser(APP_USER, { pwd: APP_PASSWORD, roles: [{ role: 'readWrite', db: DB_NAME }] });
} else {
  target.createUser({ user: APP_USER, pwd: APP_PASSWORD, roles: [{ role: 'readWrite', db: DB_NAME }] });
  print(`"${APP_USER}" oluşturuldu.`);
}
print(`.env için: MONGODB_USER=${APP_USER}  MONGODB_AUTH_SOURCE=${DB_NAME}  MONGODB_DB=${DB_NAME}`);
