// RULE: dau vet SQL Injection nhin thay duoc trong log.
//
// Day la rule an khop truc tiep voi lo hong CO Y o app/routes/customers.js
// (/customers/search noi chuoi thang vao cau SQL - xem app/README.md muc
// "Lo hong co y"). Khi khai thac bang UNION de doc app.staff, cau lenh that su
// chay tren server co chua tu khoa UNION SELECT, va no nam nguyen van trong
// log pgAudit.
//
// Doc duoc dau vet nay trong log chinh la dieu can chung minh cho lop 3: code
// ung dung sai, RLS chan duoc phan du lieu khach hang, va lop giam sat van
// nhin thay va goi ten duoc hanh vi khai thac.
//
// LUU Y: khong bat duoc IDOR o /orders/:id. Cau lenh cua IDOR la mot truy van
// hop le hoan toan binh thuong, chi khac o GIA TRI id - tu log khong the phan
// biet "xem don hang cua minh" voi "xem don hang cua nguoi khac". Chan IDOR la
// viec cua RLS, khong phai cua analyzer. Cung ghi ro diem nay trong bao cao.

// ---------------------------------------------------------------------------
// SQLI_STACKED - nhieu cau lenh noi nhau trong MOT chuoi truy van.
//
// /customers/search goi query(sql) KHONG tham so, nen node-pg gui bang giao
// thuc simple query - thu cho phep mot chuoi chua nhieu cau cach nhau bang ";".
// Mot chuoi nhu vay khong can UNION, OR 1=1 hay catalog: ba mau ben duoi deu
// khong thay. Truy van cua app luon la MOT cau, nen chuoi nhieu cau tu phien
// ung dung la dau hieu bi noi them. Nang nhat la khi chuoi tu ket thuc mot
// transaction ma no khong mo: no dang ra khoi transaction cua middleware
// setRole.js, noi SET LOCAL ROLE con hieu luc.
//
// pgAudit ghi moi cau trong chuoi thanh mot dong AUDIT rieng, va dong nao cung
// mang NGUYEN VAN ca chuoi (xem auditLine.js) - nen chi can tach chuoi do ra.
//
// Phai tach bang bo doc tu, khong dung regex /;\s*update/: dau ";" nam trong
// chuoi ky tu ('a; b'), trong ten "co;dau", trong $$than ham$$ hay trong chu
// thich deu KHONG ngat cau. Khach hang ten "Cong ty A; update gia" la du lieu
// hop le, khong phai tan cong.
//
// Hai dau hieu (chi xet khi chuoi co tu 2 cau tro len):
//   (A) co COMMIT/END/ROLLBACK/ABORT ma chinh chuoi do KHONG mo transaction
//       truoc -> dang thoat khoi transaction cua nguoi khac (cua app).
//   (B) cau DAU TIEN la cau du lieu (SELECT/INSERT/...). Truy van cua app bat
//       dau nhu vay va chi co mot cau; co them cau phia sau la bi noi vao.
// Chuoi hop le cua script quan tri khong dinh ca hai: no bat dau bang
// "SET ROLE x; ..." hoac tu mo "BEGIN; ...; ROLLBACK;".
// ---------------------------------------------------------------------------
const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;

// Tra ve mang, moi phan tu la cac tu dau (toi da 2, viet hoa) cua mot cau lenh
// o cap cao nhat. Cau rong (";;" hay chi co chu thich) bi bo qua.
function leadingWords(sql) {
  const statements = [];
  let words = [];
  let i = 0;
  const n = sql.length;

  // Bo qua chuoi trong dau nhay `q`; nhan doi dau nhay la dau nhay ben trong.
  // backslash = true chi cho chuoi E'...': voi standard_conforming_strings = on
  // (mac dinh) thi "\" trong chuoi thuong la ky tu binh thuong. Coi nham no la
  // ky tu thoat thi 'a\' ; UPDATE ... se bi doc thanh mot chuoi dai va lot.
  const skipQuoted = (q, backslash) => {
    i += 1;
    while (i < n) {
      if (backslash && sql[i] === '\\') { i += 2; continue; }
      if (sql[i] === q) {
        if (sql[i + 1] === q) { i += 2; continue; }
        i += 1;
        return;
      }
      i += 1;
    }
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === ';') {
      if (words.length) statements.push(words);
      words = [];
      i += 1;
    } else if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? n : eol + 1;
    } else if (ch === '/' && next === '*') {
      // PostgreSQL cho chu thich khoi long nhau.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
    } else if (ch === "'") {
      skipQuoted("'", false);
    } else if (ch === '"') {
      if (words.length < 2) words.push('"');   // ten trong nhay kep, khong phai tu khoa
      skipQuoted('"', false);
    } else if (ch === '$') {
      // $the$ ... $the$ (the co the rong). "$1" la tham so, khong phai chuoi.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? n : close + m[0].length;
      } else {
        i += 1;
      }
    } else if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j += 1;
      const word = sql.slice(i, j).toUpperCase();
      i = j;
      if (word === 'E' && sql[i] === "'") {
        skipQuoted("'", true);
      } else if (words.length < 2) {
        words.push(word);
      }
    } else if (ch >= '0' && ch <= '9') {
      // So (ke ca 1e5, 0x1F): doc het de chu cai ben trong khong thanh "tu".
      i += 1;
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i])) i += 1;
    } else {
      i += 1;
    }
  }

  if (words.length) statements.push(words);
  return statements;
}

const DATA_VERBS = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TABLE', 'VALUES']);
const TXN_OPEN = new Set(['BEGIN', 'START']);
const TXN_CLOSE = new Set(['COMMIT', 'END', 'ROLLBACK', 'ABORT']);
// Tu dau cau la van ban do ke tan cong viet. Chi dua vao canh bao nhung tu
// khoa SQL quen biet; con lai ghi "?" - canh bao khong chep lai du lieu tuy y
// (cung nguyen tac voi redact.js).
const KNOWN_VERBS = new Set([
  ...DATA_VERBS, ...TXN_OPEN, ...TXN_CLOSE,
  'SET', 'RESET', 'SHOW', 'DO', 'CALL', 'COPY', 'EXPLAIN', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'GRANT', 'REVOKE', 'COMMENT', 'LOCK', 'SAVEPOINT', 'RELEASE', 'PREPARE', 'EXECUTE', 'DEALLOCATE',
  'DECLARE', 'FETCH', 'MOVE', 'CLOSE', 'LISTEN', 'NOTIFY', 'UNLISTEN', 'VACUUM', 'ANALYZE',
  'DISCARD', 'CHECKPOINT', 'REINDEX', 'CLUSTER', 'REFRESH', 'LOAD', 'REASSIGN', 'SECURITY',
]);

function detectStacked(sql) {
  const statements = leadingWords(sql);
  if (statements.length < 2) return null;

  // (A) dong transaction ma chuoi nay khong mo. "ROLLBACK TO [SAVEPOINT]" chi
  // lui ve savepoint, khong ket thuc transaction.
  let opened = 0;
  let escapes = false;
  for (const [verb, second] of statements) {
    if (TXN_OPEN.has(verb)) {
      opened += 1;
    } else if (TXN_CLOSE.has(verb) && !(verb === 'ROLLBACK' && second === 'TO')) {
      if (opened === 0) { escapes = true; break; }
      opened -= 1;
    }
  }

  const first = statements[0][0];
  const verbs = statements.slice(0, 12).map((s) => (KNOWN_VERBS.has(s[0]) ? s[0] : '?'));
  if (escapes) {
    return {
      risk: 95,
      mo_ta: `Chuoi truy van noi ${statements.length} cau lenh va tu ket thuc transaction ma no khong mo (${verbs.join('; ')})`,
      verbs,
    };
  }
  if (DATA_VERBS.has(first)) {
    return {
      risk: 85,
      mo_ta: `Chuoi truy van noi ${statements.length} cau lenh sau cau truy van cua ung dung (${verbs.join('; ')})`,
      verbs,
    };
  }
  return null;
}

const PATTERNS = [
  // UNION ... SELECT: kieu khai thac de doc sang bang khac
  { re: /\bunion\b[\s\S]{0,200}?\bselect\b/i, rule: 'SQLI_UNION', risk: 90,
    mo_ta: 'Cau lenh chua UNION SELECT - dau hieu khai thac de doc sang bang khac' },
  // Tautology kieu OR 1=1 / OR 'a'='a'
  { re: /\bor\b\s+(\d+)\s*=\s*\1\b/i, rule: 'SQLI_TAUTOLOGY', risk: 85,
    mo_ta: "Dieu kien luon dung kieu OR 1=1 - dau hieu vuot qua bo loc" },
  { re: /\bor\b\s+'([^']*)'\s*=\s*'\1'/i, rule: 'SQLI_TAUTOLOGY', risk: 85,
    mo_ta: "Dieu kien luon dung kieu OR 'a'='a' - dau hieu vuot qua bo loc" },
  // Ghep chuoi de doc metadata
  { re: /\b(pg_catalog\.|information_schema\.)/i, rule: 'SQLI_SCHEMA_PROBE', risk: 70,
    mo_ta: 'Truy van vao catalog he thong tu phien ung dung - dau hieu do la cau truc CSDL' },
];

module.exports = {
  name: 'SQL_INJECTION',
  detectStacked,   // xuat ra de thu rieng bo tach cau

  run(stmt) {
    // Chi soi cau lenh doc/ghi du lieu. DDL cua quan tri vien khong tinh.
    // DENIED = cau lenh bi tu choi quyen (xem accessDenied.js): khai thac that
    // bai van la khai thac, van phai goi dung ten SQLI_*.
    if (stmt.class !== 'READ' && stmt.class !== 'WRITE' && stmt.class !== 'DENIED') return null;

    // Xet truoc cac mau ben duoi: mot chuoi vua noi cau vua co UNION thi viec
    // noi cau la phan nang hon. Moi cau du lieu trong chuoi sinh mot canh bao
    // (pgAudit ghi tung cau) - `lenh` cho biet canh bao nay la cua cau nao.
    const stacked = detectStacked(stmt.statement || '');
    if (stacked) {
      return {
        rule: 'SQLI_STACKED',
        risk: stacked.risk,
        detail: { mo_ta: stacked.mo_ta, lenh: stmt.command, cac_cau: stacked.verbs, bang: stmt.relations },
      };
    }

    for (const p of PATTERNS) {
      if (p.re.test(stmt.statement)) {
        return {
          rule: p.rule,
          risk: p.risk,
          detail: { mo_ta: p.mo_ta, bang: stmt.relations },
        };
      }
    }
    return null;
  },
};
