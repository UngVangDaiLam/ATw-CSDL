const fs = require('fs');
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

// File trang thai nam trong THU MUC RIENG analyzer/state/ de mount duoc vao
// container (service `analyzer`): watch trong container va batch tren host
// PHAI chung mot file, neu khong thi tat container roi chay gen-alerts.sh tren
// host la batch doc lai tu vi tri cu cua no va ghi trung moi thu container da
// ghi. Ban cu de file o analyzer/.analyzer-state.json (lan voi ma nguon, khong
// mount rieng duoc) - gap duong dan cu thi chuyen sang cho moi.
const LEGACY_STATE = path.join(ROOT, '.analyzer-state.json');
const DEFAULT_STATE = path.join(ROOT, 'state', 'analyzer-state.json');

function resolveStateFile() {
  const wanted = path.resolve(ROOT, process.env.STATE_FILE || DEFAULT_STATE);
  const legacyConfigured = wanted === LEGACY_STATE;
  if (wanted !== DEFAULT_STATE && !legacyConfigured) return wanted;   // container: /state/...

  try {
    fs.mkdirSync(path.dirname(DEFAULT_STATE), { recursive: true });
    if (fs.existsSync(LEGACY_STATE) && !fs.existsSync(DEFAULT_STATE)) {
      fs.renameSync(LEGACY_STATE, DEFAULT_STATE);
      console.error(`[analyzer] Da chuyen file trang thai cu sang ${DEFAULT_STATE}`);
    }
  } catch (err) {
    console.error(`[analyzer] Khong chuyen duoc file trang thai cu: ${err.message}`);
  }
  if (legacyConfigured) {
    console.error('[analyzer] STATE_FILE trong analyzer/.env la duong dan cu - xoa dong do (mac dinh da dung).');
  }
  return DEFAULT_STATE;
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
  // Nhat ky su kien bao mat o tang web do app/ ghi (app/src/securityLog.js):
  // do mat khau bi khoa, CSRF bi chan - nhung thu khong de lai dau vet trong
  // log pgAudit. Xem src/appEvents.js.
  appLogDir: path.resolve(ROOT, process.env.APP_LOG_DIR || '../logs/app'),
  stateFile: resolveStateFile(),

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
