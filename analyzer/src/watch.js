// CHE DO THEO DOI LIEN TUC (node src/index.js --watch)
//
// Doc log moi moi vai giay va ghi canh bao ngay khi phat hien, de dashboard
// hien canh bao ma khong ai phai go lenh chay analyzer. Dung chung rule,
// redact va file trang thai voi che do batch (pipeline.js).
//
// KHONG phai "goi lai batch moi 2 giay". Ba khac biet co chu dich:
//
// 1. MOT SessionTracker song suot ca tien trinh. Moi lan chay batch tao
//    tracker moi nen quen mat SET ROLE cua lan truoc. Goi lai moi 2 giay thi
//    ranh gioi giua hai lan doc roi vao giua "SET LOCAL ROLE nv_hn01" va cau
//    SELECT ngay sau no rat thuong xuyen - cau do bi quy cho app_user, mat
//    dung thu lop 3 can chung minh.
//
// 2. Khong flushAll() moi nhip - xem sessions.js flushIdle().
//
// 3. Doc theo vi tri byte (tail.js), khong quet lai ca file moi nhip.
//
// LUU TRANG THAI: chi khi (a) moi canh bao da ghi xong vao DB, va (b) khong
// luu qua dong bat dau cua cau lenh con dang gom do. Bi dung dot ngot thi lan
// sau doc lai mot doan va co the ghi trung vai canh bao - cung nguyen tac voi
// batch: tha trung con hon bo sot.
//
// GIOI HAN DA BIET: vai da SET ROLE cua mot phien chi nam trong bo nho. Khoi
// dong lai giua chung mot phien dang mo thi cac cau sau do cua phien ay bi quy
// cho session user cho toi lan SET ROLE ke tiep. Voi app/ thi moi request deu
// SET LOCAL ROLE lai tu dau nen chi lech toi da mot request.

const path = require('path');

const config = require('./config');
const SessionTracker = require('./sessions');
const AlertWriter = require('./alerts');
const { listJsonLogs } = require('./logReader');
const { byteOffsetOfLine, readNew } = require('./tail');
const {
  evaluate, isLocalSocket, printAlert, loadState, saveState,
  acquireWatchLock, releaseWatchLock, heartbeat, describeWatcher,
} = require('./pipeline');

const MAX_WRITE_PER_TICK = 500;
// DB mat lau ma log van chay -> hang doi phinh vo han. Qua nguong nay thi tam
// ngung doc log (log van nam tren dia, vi tri chua luu, se doc lai sau).
const MAX_QUEUE = 5000;

const clock = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',   // trung log_timezone, du analyzer chay trong container UTC
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const ts = () => clock.format(new Date());
const log = (msg) => console.log(`[${ts()}] ${msg}`);

// Mo ta loi cho nguoi doc. Ket noi bi tu choi (DB dang tat) tren Windows la
// AggregateError co message RONG - phai lay tu cac loi con hoac ma loi.
function describe(err) {
  if (err.message) return err.message;
  if (Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => e.code || e.message).filter(Boolean).join(', ') || 'loi ket noi';
  }
  return err.code || String(err) || 'loi khong ro';
}

async function watch(args) {
  if (args.since !== undefined) {
    console.error('--since khong dung voi --watch.');
    process.exit(1);
  }
  // Hai watch cung luc cung ghi trung nhu watch + batch.
  if (!args.dryRun) {
    const other = acquireWatchLock();
    if (other) {
      console.error(`Da co analyzer --watch khac dang chay (${describeWatcher(other)}). Dung no truoc.`);
      process.exit(1);
    }
    // 'exit' chay ca khi process.exit() lan khi het viec; kill -9 thi khong,
    // nhung khi do PID chet va file khoa tu coi nhu bo (pipeline.js).
    process.on('exit', releaseWatchLock);
  }

  const intervalMs = Math.max(500, args.intervalMs || Number(process.env.WATCH_INTERVAL_MS) || 2000);
  const state = loadState(config.stateFile, args.all);
  let lastSaved = JSON.stringify(state);

  const positions = new Map();   // ten file -> { offset (byte), lineNo }
  const queue = [];              // canh bao da phat hien, chua ghi duoc
  const counters = { lines: 0, statements: 0, skippedLocal: 0, written: 0, bad: 0 };

  const tracker = new SessionTracker((stmt) => {
    counters.statements += 1;
    if (isLocalSocket(stmt)) {
      counters.skippedLocal += 1;
      return;
    }
    queue.push(...evaluate(stmt));
  });
  const writer = new AlertWriter(config.db, { dryRun: args.dryRun });

  // Moi loi chi in MOT lan cho toi khi het, khong spam moi 2 giay.
  const shown = { db: null, logs: null, files: new Map() };

  console.log('Analyzer - che do theo doi lien tuc (Ctrl+C de dung)');
  console.log(`  Thu muc log : ${config.logDir}`);
  console.log(`  Chu ky      : ${intervalMs} ms`);
  console.log(`  Ghi vao     : ${args.dryRun ? '(--dry-run, KHONG ghi DB)' : `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`}`);
  console.log('');

  function readLogs() {
    const files = listJsonLogs(config.logDir);
    if (files.length === 0) {
      if (!shown.logs) log(`Chua thay file .json nao trong ${config.logDir} - dang cho PostgreSQL ghi log...`);
      shown.logs = true;
      return;
    }
    if (shown.logs) log('Da thay file log, bat dau doc.');
    shown.logs = null;

    for (const file of files) {
      // Một file đọc không được (sai quyền, vừa bị xóa) không được chặn các
      // file sau nó - nếu không thì toàn bộ log mới đều bị bỏ qua.
      try {
        readOne(file);
        shown.files.delete(path.basename(file));
      } catch (err) {
        const name = path.basename(file);
        const why = describe(err);
        if (shown.files.get(name) !== why) log(`Khong doc duoc ${name}: ${why}`);
        shown.files.set(name, why);
      }
    }
  }

  function readOne(file) {
    const name = path.basename(file);
    let pos = positions.get(name);
    if (!pos) {
      // Lan dau gap file trong tien trinh nay: tiep tuc tu cho file trang
      // thai ghi (co the do batch de lai).
      const lines = state.files[name]?.lines || 0;
      pos = { offset: byteOffsetOfLine(file, lines), lineNo: lines };
      positions.set(name, pos);
    }
    // Doc het phan moi (moi lan readNew toi da 8 MB).
    for (;;) {
      const r = readNew(file, pos.offset, pos.lineNo);
      if (r.truncated) {
        log(`${name} ngan lai (bi lam lai?) - doc lai tu dau file.`);
        pos.offset = 0;
        pos.lineNo = 0;
        continue;
      }
      counters.bad += r.bad;
      for (const { lineNo, record } of r.records) {
        counters.lines += 1;
        tracker.feed(record, { file: name, line: lineNo });
      }
      const moved = r.offset !== pos.offset;
      pos.offset = r.offset;
      pos.lineNo = r.lineNo;
      if (!moved) break;
    }
  }

  // Ghi hang doi vao audit.alerts. Tra ve true neu hang doi da rong.
  async function drain() {
    if (queue.length === 0) return true;
    const batch = queue.slice(0, MAX_WRITE_PER_TICK);

    if (!args.dryRun) {
      try {
        if (!writer.connected) {
          await writer.close();
          await writer.connect();
        }
        await writer.writeAll(batch);
      } catch (err) {
        await writer.close();
        const why = describe(err);
        if (shown.db !== why) {
          log(`Khong ghi duoc audit.alerts: ${why}`);
          log(`  ${queue.length} canh bao dang cho, se thu lai moi ${intervalMs} ms.`);
          if (/password|role|permission/i.test(why)) {
            log('  Kiem tra analyzer/.env (DB_USER phai la analyzer_user).');
          }
        }
        shown.db = why;
        return false;
      }
      if (shown.db) log('Ket noi lai database thanh cong.');
      shown.db = null;
    }

    queue.splice(0, batch.length);
    counters.written += batch.length;
    log(`+${batch.length} canh bao${args.dryRun ? ' (dry-run, khong ghi)' : ' -> audit.alerts'}`);
    if (!args.quiet) for (const a of batch) printAlert(a);
    return queue.length === 0;
  }

  function saveSafe() {
    if (args.dryRun) return;
    for (const [name, pos] of positions) {
      const pending = tracker.earliestPendingLine(name);
      state.files[name] = { lines: pending === null ? pos.lineNo : Math.max(0, pending - 1) };
    }
    const json = JSON.stringify(state);
    if (json === lastSaved) return;
    saveState(config.stateFile, state);
    lastSaved = json;
  }

  let stopping = false;
  let timer = null;
  let running = Promise.resolve();
  let first = true;

  async function tick() {
    tracker.tick += 1;
    if (!args.dryRun) heartbeat();
    if (queue.length < MAX_QUEUE) {
      try {
        readLogs();
      } catch (err) {
        log(`Loi khi doc log: ${describe(err)}`);
      }
    }
    tracker.flushIdle();
    if (await drain()) saveSafe();

    if (first) {
      first = false;
      log(`Da doc ${counters.lines} dong log ton dong. Dang theo doi...`);
    }
  }

  function schedule() {
    if (stopping) return;
    timer = setTimeout(() => {
      running = tick().catch((err) => log(`Loi: ${err.stack || err.message}`)).finally(schedule);
    }, intervalMs);
  }

  async function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    log(`Nhan ${sig}, dang ghi not truoc khi dung...`);
    await running;
    // Dung han: cau lenh dang gom do coi nhu da xong.
    tracker.flushAll();
    let ok = true;
    while (queue.length > 0 && ok) ok = await drain();
    if (ok) saveSafe();
    await writer.close();
    console.log('--------------------------------------------');
    console.log(`Doc      : ${counters.lines} dong log, ${counters.statements} cau lenh`);
    console.log(`Bo qua   : ${counters.skippedLocal} cau lenh qua unix socket`);
    console.log(`${args.dryRun ? 'Phat hien' : 'Da ghi  '} : ${counters.written} canh bao`);
    if (counters.bad) console.log(`Dong hong: ${counters.bad} (bo qua)`);
    if (!ok) console.log(`CHUA GHI : ${queue.length} canh bao (database khong san sang) - lan chay sau se doc lai.`);
    console.log('--------------------------------------------');
    process.exit(ok ? 0 : 1);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  running = tick().catch((err) => log(`Loi: ${err.stack || err.message}`)).finally(schedule);
}

module.exports = { watch };
