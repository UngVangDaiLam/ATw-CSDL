#!/usr/bin/env node
//
// analyzer - LOP 3: doc log pgAudit, phat hien hanh vi bat thuong, ghi canh bao
// vao audit.alerts.
//
//   node src/index.js                 doc phan log moi, ghi canh bao vao DB
//   node src/index.js --dry-run       chi in ra man hinh, khong ghi DB
//   node src/index.js --all           doc lai tu dau (bo qua file trang thai)
//   node src/index.js --quiet         chi in phan tong ket
//
// Chay mot lan roi thoat (batch). Muon theo doi lien tuc thi goi lai dinh ky -
// file trang thai bao dam khong sinh canh bao trung.

const fs = require('fs');
const path = require('path');

const config = require('./config');
const rules = require('./rules');
const SessionTracker = require('./sessions');
const AlertWriter = require('./alerts');
const { readJsonLog, listJsonLogs } = require('./logReader');
const { redactStatement } = require('./redact');

const MAX_ALERTS_PER_RUN = 2000;

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    all: argv.includes('--all'),
    quiet: argv.includes('--quiet'),
  };
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

function saveState(file, state) {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState(config.stateFile, args.all);

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

    // Bo qua phien qua unix socket (superuser, script init). Xem config.js.
    if (config.ignoreLocalSocket && (!stmt.remoteHost || stmt.remoteHost === '[local]')) {
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

    const name = path.basename(file);
    const already = state.files[name]?.lines || 0;
    let lastLine = already;

    for await (const { lineNo, record } of readJsonLog(file, already)) {
      counters.lines += 1;
      lastLine = lineNo;
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
    for (const a of sorted) {
      const d = a.detail;
      console.log(
        `[${String(a.risk_score).padStart(2)}] ${a.rule_triggered.padEnd(22)} ${String(a.db_user).padEnd(14)} ${d.thoi_diem}`
      );
      console.log(`     ${d.mo_ta}`);
      console.log(`     ${d.cau_lenh}`);
    }
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
