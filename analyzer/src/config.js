const path = require('path');

// Goc cua package analyzer/, KHONG phai thu muc dang dung khi goi lenh.
const ROOT = path.resolve(__dirname, '..');

// Nap dung analyzer/.env du duoc goi tu dau. Mac dinh dotenv doc .env trong
// thu muc hien hanh, nen chay "node analyzer/src/index.js" tu goc repo se nap
// nham file .env cua ha tang Docker - file do khong co DB_USER nen analyzer se
// lang le ket noi bang role khac voi role no phai dung. scripts/verify.sh goi
// analyzer tu goc repo nen day khong phai truong hop hiem.
require('dotenv').config({ path: path.join(ROOT, '.env') });

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  // Ket noi bang analyzer_user - role CHI co INSERT tren audit.alerts.
  // KHONG dung app_user: bo phan tich khong co viec gi voi du lieu nghiep vu,
  // cho no muon danh tinh cua ca ung dung la tu tay pha nguyen tac dac quyen
  // toi thieu ma lop 1 dang chung minh. Xem postgres/init/04_grants.sql.
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num(process.env.DB_PORT, 15432),
    database: process.env.DB_NAME || 'secdb',
    user: process.env.DB_USER || 'analyzer_user',
    password: process.env.DB_PASSWORD,
  },

  // Thu muc log va file ghi nho vi tri da doc.
  // Duong dan tuong doi trong .env duoc tinh tu goc analyzer/ (khong phai tu
  // thu muc dang dung), nen "LOG_DIR=../logs" luon tro dung ./logs cua repo.
  // path.resolve van ton trong duong dan tuyet doi neu ai do dat kieu do.
  logDir: path.resolve(ROOT, process.env.LOG_DIR || '../logs'),
  stateFile: path.resolve(ROOT, process.env.STATE_FILE || '.analyzer-state.json'),

  // Bang duoc coi la nhay cam. Them bang moi vao app thi can nhac them o day.
  sensitiveTables: list(process.env.SENSITIVE_TABLES, [
    'app.customers',
    'app.payments',
  ]),
  // Bang chua thong tin dang nhap - doc no tu mot phien nhan vien la dau hieu
  // xau (xem rules/staffCredentialRead.js).
  credentialTable: process.env.CREDENTIAL_TABLE || 'app.staff',

  // Gio hanh chinh, theo log_timezone cua database (Asia/Ho_Chi_Minh).
  businessHours: {
    start: num(process.env.BUSINESS_HOUR_START, 7),
    end: num(process.env.BUSINESS_HOUR_END, 19),
    // true = thu 7, chu nhat cung bi coi la ngoai gio
    flagWeekend: process.env.FLAG_WEEKEND !== 'false',
  },

  // So ban ghi bi giai ma trong MOT cau lenh de bi coi la rut du lieu hang loat.
  bulkDecryptThreshold: num(process.env.BULK_DECRYPT_THRESHOLD, 50),

  // Bo qua cac phien di qua unix socket (remote_host = "[local]"). Do la
  // duong cua superuser va cua chinh docker-entrypoint luc khoi tao - rieng
  // lan seed da de lai 47.000 dong log. Dat false de soi ca hoat dong quan tri.
  ignoreLocalSocket: process.env.IGNORE_LOCAL_SOCKET !== 'false',
};
