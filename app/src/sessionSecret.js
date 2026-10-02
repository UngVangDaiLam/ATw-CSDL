// Khoa ky cookie phien (express-session).
//
// Ai biet khoa nay thi tu ky duoc cookie phien hop le. Ban goc co gia tri mac
// dinh viet thang trong code: thieu cau hinh la app van chay, voi mot khoa ai
// cung doc duoc tren GitHub. Gio thieu khoa, dung gia tri mau, hoac khoa qua
// ngan thi app TU CHOI khoi dong - loi cau hinh phai lo ra ngay, khong am tham.
//
// Nguon khoa:
//   - Docker: file Docker secret, tro bang SESSION_SECRET_FILE (sinh boi
//     scripts/init-secrets.sh). Khong dung bien moi truong vi `docker inspect`
//     doc duoc - cung ly do voi khoa ma hoa o lop 2.
//   - Chay tay tren host: SESSION_SECRET trong app/.env.

const fs = require('fs');

const PLACEHOLDERS = new Set(['doi_chuoi_bi_mat_nay', 'doi_chuoi_bi_mat_nay_9', 'secret', 'changeme']);
const MIN_LENGTH = 32;

function loadSessionSecret(env = process.env) {
  let secret = env.SESSION_SECRET || '';
  let source = 'SESSION_SECRET';

  if (env.SESSION_SECRET_FILE) {
    source = env.SESSION_SECRET_FILE;
    try {
      secret = fs.readFileSync(env.SESSION_SECRET_FILE, 'utf8').trim();
    } catch (err) {
      throw new Error(`Khong doc duoc ${source} (${err.code || err.message}). Chay: bash scripts/init-secrets.sh`);
    }
  }

  if (!secret) {
    throw new Error('Thieu SESSION_SECRET. Sinh mot chuoi ngau nhien: openssl rand -hex 32');
  }
  if (PLACEHOLDERS.has(secret)) {
    throw new Error(`${source} dang la gia tri mau trong tai lieu. Doi bang: openssl rand -hex 32`);
  }
  if (secret.length < MIN_LENGTH) {
    throw new Error(`${source} qua ngan (${secret.length} ky tu, can >= ${MIN_LENGTH}). Dung: openssl rand -hex 32`);
  }
  return secret;
}

module.exports = { loadSessionSecret };
