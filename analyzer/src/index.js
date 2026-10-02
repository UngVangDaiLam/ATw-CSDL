#!/usr/bin/env node
//
// analyzer - LOP 3: doc log pgAudit, phat hien hanh vi bat thuong, ghi canh bao
// vao audit.alerts.
//
//   node src/index.js                 doc phan log moi, ghi canh bao vao DB
//   node src/index.js --dry-run       chi in ra man hinh, khong ghi DB
//   node src/index.js --all           doc lai tu dau (bo qua file trang thai)
//   node src/index.js --quiet         chi in phan tong ket
//   node src/index.js --watch         theo doi lien tuc, xem src/watch.js
//   node src/index.js --dry-run --since="2026-10-02 22:35:00"
//                                     chi xet log tu thoi diem do (nghiem thu)
//
// Mac dinh chay mot lan roi thoat (batch). --watch giu tien trinh song, doc
// log moi moi vai giay va ghi canh bao ngay khi phat hien. Ca hai dung chung
// file trang thai nen chuyen qua lai giua hai che do khong sinh canh bao trung.
//
// MA THOAT: 0 thanh cong, 1 loi, 3 = co --watch dang chay nen lan batch nay
// nhuong (khong ghi) - script goi analyzer nen cho watch tu ghi.

const path = require('path');

const config = require('./config');
const SessionTracker = require('./sessions');
const AlertWriter = require('./alerts');
const { readJsonLog, listJsonLogs } = require('./logReader');
const {
  evaluate, isLocalSocket, printAlert, loadState, saveState,
  activeWatcher, describeWatcher, parseSince, fileMayContainSince, recordAtOrAfter,
} = require('./pipeline');

const MAX_ALERTS_PER_RUN = 2000;
const EXIT_WATCHER_ACTIVE = 3;

function parseArgs(argv) {
  const value = (name) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : undefined;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    all: argv.includes('--all'),
    quiet: argv.includes('--quiet'),
    watch: argv.includes('--watch'),
    intervalMs: value('interval') ? Number(value('interval')) : undefined,
    since: value('since'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.watch) return require('./watch').watch(args);

  let since = null;
  if (args.since !== undefined) {
    since = parseSince(args.since);
    if (!since) {
      console.error(`--since phai co dang "YYYY-MM-DD HH:MM:SS[.mmm]" theo gio VN, nhan: "${args.since}"`);
      process.exit(1);
    }
    // --since bo qua file trang thai; ghi that se trung canh bao da co.
    if (!args.dryRun) {
      console.error('--since chi dung kem --dry-run (danh cho nghiem thu, khong ghi DB).');
      process.exit(1);
    }
  }

  // Watch dang song thi no da/se xu ly dung doan log nay - ghi them la trung.
  // --dry-run khong ghi gi nen van cho chay (scripts/verify.sh dung).
  if (!args.dryRun) {
    const watcher = activeWatcher();
    if (watcher) {
      console.log(`analyzer --watch dang chay (${describeWatcher(watcher)}) - canh bao se do no ghi.`);
      console.log('Lan chay nay KHONG ghi, de tranh trung canh bao.');
      process.exit(EXIT_WATCHER_ACTIVE);
    }
  }

  const state = loadState(config.stateFile, args.all || Boolean(since));

  const files = listJsonLogs(config.logDir);
  if (files.length === 0) {
    console.error(`Khong tim thay file .json nao trong ${config.logDir}`);
    console.error('Kiem tra log_destination trong postgres/conf/postgresql.conf va thu muc ./logs.');
    process.exit(1);
  }

  const alerts = [];
  const counters = { lines: 0, statements: 0, skippedLocal: 0 };
  let capReached = false;

  const tracker = new SessionTracker((stmt) => {
    counters.statements += 1;

    if (isLocalSocket(stmt)) {
      counters.skippedLocal += 1;
      return;
    }

    if (alerts.length >= MAX_ALERTS_PER_RUN) {
      capReached = true;
      return;
    }
    alerts.push(...evaluate(stmt));
  });

  for (const file of files) {
    if (capReached) break;   // giu nguyen trang thai cac file con lai
    if (since && !fileMayContainSince(file, since)) continue;

    const name = path.basename(file);
    const already = state.files[name]?.lines || 0;
    let lastLine = already;

    for await (const { lineNo, record } of readJsonLog(file, already)) {
      lastLine = lineNo;
      if (since && !recordAtOrAfter(record, since)) continue;
      counters.lines += 1;
      tracker.feed(record);
      if (capReached) break;
    }
    tracker.flushAll();

    state.files[name] = { lines: lastLine };
  }

  // In ket qua ra console (de bai yeu cau co dau ra nhin thay duoc), sap theo
  // muc do rui ro giam dan.
  const sorted = [...alerts].sort((a, b) => b.risk_score - a.risk_score);

  if (!args.quiet) {
    for (const a of sorted) printAlert(a);
    if (sorted.length > 0) console.log('');
  }

  const writer = new AlertWriter(config.db, { dryRun: args.dryRun });
  try {
    await writer.connect();
    await writer.writeAll(sorted);
  } catch (err) {
    console.error(`Loi khi ghi audit.alerts: ${err.message}`);
    console.error('Kiem tra analyzer/.env (DB_USER phai la analyzer_user) va pg_hba.conf.');
    process.exit(1);
  } finally {
    await writer.close();
  }

  // Chi luu trang thai khi da ghi xong: dut giua chung thi lan sau doc lai,
  // tha canh bao trung con hon bo sot.
  if (!args.dryRun) saveState(config.stateFile, state);

  const byRule = sorted.reduce((acc, a) => {
    acc[a.rule_triggered] = (acc[a.rule_triggered] || 0) + 1;
    return acc;
  }, {});

  console.log('--------------------------------------------');
  console.log(`Doc      : ${counters.lines} dong log moi, ${counters.statements} cau lenh`);
  console.log(`Bo qua   : ${counters.skippedLocal} cau lenh qua unix socket (quan tri/init)`);
  console.log(`Canh bao : ${sorted.length}`);
  for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`           ${rule.padEnd(22)} ${n}`);
  }
  console.log(args.dryRun ? 'Che do   : --dry-run, KHONG ghi vao audit.alerts' : `Da ghi   : ${writer.written} dong vao audit.alerts`);
  if (capReached) {
    console.log(`CANH BAO : cham tran ${MAX_ALERTS_PER_RUN} canh bao/lan chay, phan con lai se doc o lan sau.`);
  }
  console.log('--------------------------------------------');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
