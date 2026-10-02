// Phan dung chung giua che do batch (index.js) va che do theo doi lien tuc
// (watch.js): bien su kien cau lenh thanh canh bao, in ra man hinh, va doc/ghi
// file trang thai. Hai che do PHAI dung chung mot ham evaluate() - neu tach ra
// thi mot rule sua o che do nay se lang le khac ket qua o che do kia.

const fs = require('fs');

const config = require('./config');
const rules = require('./rules');
const { redactStatement } = require('./redact');

// Bien mot su kien cau lenh thanh cac canh bao (co the nhieu rule cung an).
function evaluate(stmt) {
  const out = [];
  for (const rule of rules) {
    let hit = null;
    try {
      hit = rule.run(stmt, config);
    } catch (err) {
      console.error(`Rule ${rule.name} loi: ${err.message}`);
      continue;
    }
    if (!hit) continue;

    out.push({
      db_user: stmt.actor,
      rule_triggered: hit.rule,
      risk_score: hit.risk,
      detail: {
        ...hit.detail,
        // Cau lenh da che du lieu nhay cam - xem redact.js. Bang audit.alerts
        // KHONG duoc ma hoa, nen khong duoc phep chua CCCD hay so the o dang ro.
        cau_lenh: redactStatement(stmt.statement),
        session_id: stmt.sessionId,
        pid: stmt.pid,
        // session user luon la app_user; giu lai de doi chieu voi log tho va de
        // thay ro no KHAC voi db_user o tren - do chinh la cho ma viec bam theo
        // phien tao ra gia tri.
        session_user: stmt.sessionUser,
        client: stmt.remoteHost,
        ung_dung: stmt.appName,
        thoi_diem: stmt.timestamp,
      },
    });
  }
  return out;
}

// Bo qua phien qua unix socket (superuser, script init). Xem config.js.
function isLocalSocket(stmt) {
  return config.ignoreLocalSocket && (!stmt.remoteHost || stmt.remoteHost === '[local]');
}

function printAlert(a) {
  const d = a.detail;
  console.log(
    `[${String(a.risk_score).padStart(2)}] ${a.rule_triggered.padEnd(22)} ${String(a.db_user).padEnd(14)} ${d.thoi_diem}`
  );
  console.log(`     ${d.mo_ta}`);
  console.log(`     ${d.cau_lenh}`);
}

function loadState(file, ignore) {
  if (ignore || !fs.existsSync(file)) return { files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.files ? parsed : { files: {} };
  } catch (err) {
    console.error(`Khong doc duoc file trang thai (${file}), coi nhu chay lai tu dau.`);
    return { files: {} };
  }
}

// Ghi ra file tam roi doi ten: che do watch ghi file nay lien tuc, bi ngat
// (Ctrl+C, container dung) dung luc dang ghi thi file trang thai khong duoc
// phep bi cut nua chung - mat no la doc lai toan bo log va ghi trung canh bao.
function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// KHOA CHE DO WATCH
//
// Watch giu vi tri da doc trong BO NHO, batch doc tu file trang thai - hai ben
// khong biet nhau. Chay batch (gen-alerts.sh, demo-attack.sh) trong luc watch
// dang song thi ca hai cung xu ly mot doan log va GHI TRUNG canh bao (da tai
// hien: cung mot cau UNION ra 6 dong thay vi 3). Watch ghi PID vao file khoa;
// batch thay watch con song thi nhuong, khong ghi.
//
// SONG HAY CHET XET BANG NHIP TIM, KHONG CHI BANG PID. Watch co the chay trong
// container (service `analyzer` cua docker-compose) trong khi batch chay tren
// may host - hai ben chung thu muc trang thai nhung KHAC khong gian PID: PID 7
// trong container khong noi gi ve PID 7 tren host. Watch ghi lai moc thoi gian
// vao file khoa moi nhip; ai thay moc con moi thi biet watch con song, du no o
// dau. Cung may (cung hostname) thi kiem tra them PID de nhan ra watch chet
// ngay, khong phai doi het han.
//
// Watch bi kill -9 / may tat dot ngot: file khoa con do nhung nhip tim ngung,
// qua STALE_MS la tu coi nhu bo - khong ai phai xoa tay.
const os = require('os');

const STALE_MS = 30000;   // rong hon nhieu so voi nhip 2 s: nhip dau co the
                          // phai doc ca dong log ton dong, mat vai giay

function lockFile() {
  return `${config.stateFile}.watch.lock`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);   // tin hieu 0: chi hoi tien trinh con ton tai khong
    return true;
  } catch (err) {
    return err.code === 'EPERM';   // ton tai nhung khong co quyen gui tin hieu
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
  } catch {
    return null;   // khong co file khoa, hoac file hong -> coi nhu khong co watch
  }
}

const isSelf = (lock) => lock.pid === process.pid && lock.host === os.hostname();

// Watch khac dang song: tra ve { pid, host }, khong co thi null.
function activeWatcher() {
  const lock = readLock();
  if (!lock || !Number.isInteger(lock.pid) || isSelf(lock)) return null;
  if (Date.now() - Number(lock.beat || 0) > STALE_MS) return null;
  if (lock.host === os.hostname() && !pidAlive(lock.pid)) return null;
  return { pid: lock.pid, host: lock.host };
}

function writeLock() {
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, host: os.hostname(), beat: Date.now() }));
}

// Tra ve watch khac neu da co, null neu lay khoa thanh cong.
function acquireWatchLock() {
  const other = activeWatcher();
  if (other) return other;
  writeLock();
  return null;
}

// Watch goi moi nhip de giu khoa.
function heartbeat() {
  try {
    writeLock();
  } catch {
    /* thu muc trang thai tam thoi khong ghi duoc - nhip sau thu lai */
  }
}

function releaseWatchLock() {
  const lock = readLock();
  if (lock && isSelf(lock)) {
    try {
      fs.unlinkSync(lockFile());
    } catch {
      /* da xoa roi */
    }
  }
}

function describeWatcher(w) {
  return w.host === os.hostname() ? `pid ${w.pid}` : `may/container ${w.host}`;
}

// ---------------------------------------------------------------------------
// --since: chi xet dong log tu mot thoi diem tro di (danh cho nghiem thu).
//
// scripts/verify.sh tu tao vai hanh vi xau roi chay analyzer --dry-run de xem
// co bat duoc khong. Neu doc tiep tu file trang thai nhu binh thuong thi mot
// watch dang chay co the da xu ly va luu vi tri VUOT QUA cac dong do truoc khi
// verify kip doc -> dry-run khong thay gi, phep thu truot that thuong.
//
// Thoi diem viet theo log_timezone (Asia/Ho_Chi_Minh), dang
// "YYYY-MM-DD HH:MM:SS[.mmm]" - cung khuon voi truong timestamp trong log nen
// so sanh CHUOI la du, khong qua new Date() (xem CLAUDE.md muc analyzer).
const SINCE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;

function parseSince(value) {
  if (!SINCE_RE.test(value || '')) return null;
  const [base, frac = ''] = value.split('.');
  return `${base}.${frac.padEnd(3, '0')}`;
}

// File sua lan cuoi truoc thoi diem `since` thi khong the chua dong nao sau
// no - bo qua cho nhanh. Chi dung de LOC FILE (mtime la gio he thong); viec so
// sanh tung dong van theo chuoi timestamp.
function fileMayContainSince(filePath, since) {
  const t = new Date(`${since.replace(' ', 'T')}+07:00`).getTime();
  try {
    return fs.statSync(filePath).mtimeMs >= t - 1000;
  } catch {
    return false;
  }
}

function recordAtOrAfter(record, since) {
  return String(record.timestamp || '').slice(0, 23) >= since;
}

module.exports = {
  evaluate, isLocalSocket, printAlert, loadState, saveState,
  activeWatcher, acquireWatchLock, releaseWatchLock, heartbeat, describeWatcher,
  parseSince, fileMayContainSince, recordAtOrAfter,
};
