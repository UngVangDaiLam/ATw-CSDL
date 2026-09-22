// Parse truong `message` cua mot dong log pgAudit.
//
// Dinh dang pgAudit sinh ra:
//   AUDIT: SESSION,<stmt_id>,<substmt_id>,<class>,<command>,<obj_type>,<obj_name>,<statement>,<parameter>
//
// Phan sau "AUDIT: " la MOT DONG CSV: truong nao chua dau phay/nhay/xuong dong
// thi duoc boc trong dau nhay kep, va dau nhay ben trong bi nhan doi (""). Vi
// vay KHONG the tach bang split(',') - cau SQL nao co dau phay la vo ngay.
//
// VI SAO PHAI DOC BAN .json CHU KHONG PHAI .csv:
// cau SQL trong log co the chua ca ky tu xuong dong that (xem than ham
// app.encrypt_text trong 05_crypto.sql - no viet nhieu dong). Trong file .csv
// cua PostgreSQL, mot "dong" log khi do trai ra nhieu dong van ban, doc theo
// tung dong la rach cau lenh lam doi. File .json thi moi ban ghi gon trong
// dung mot dong vi ky tu xuong dong da duoc escape thanh \n.

const AUDIT_PREFIX = 'AUDIT: ';

// Tach mot dong CSV thanh mang truong, ton trong dau nhay kep va quy tac
// nhan doi dau nhay ("" -> ").
function splitCsv(text) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields;
}

// Tra ve null neu dong nay khong phai dong AUDIT (connection received,
// checkpoint, statement: ... cua log_statement='ddl', v.v.)
function parseAuditMessage(message) {
  if (typeof message !== 'string' || !message.startsWith(AUDIT_PREFIX)) return null;

  const fields = splitCsv(message.slice(AUDIT_PREFIX.length));
  if (fields.length < 9) return null;

  return {
    auditType: fields[0],                  // SESSION hoac OBJECT
    statementId: Number(fields[1]),
    // substatementId > 1 nghia la cau lenh LONG NHAU - than cua mot ham
    // SQL/PLpgSQL, KHONG phai cau lenh client gui len. Xem giai thich o
    // sessions.js, day la truong quan trong nhat de loc nhieu.
    substatementId: Number(fields[2]),
    class: fields[3],                      // READ | WRITE | DDL | ROLE | MISC | FUNCTION
    command: fields[4],                    // SELECT | INSERT | SET | ...
    objectType: fields[5],                 // TABLE, VIEW, ... (can pgaudit.log_relation = on)
    objectName: fields[6],                 // app.customers
    statement: fields[7],
    parameter: fields[8],                  // luon la <not logged> - xem CLAUDE.md
  };
}

// Lay ten role tu cau SET ROLE / SET LOCAL ROLE.
//
// CAN THAN: khi client gui nhieu cau trong MOT query string (vi du
// "SET ROLE nv_dn01; SELECT ... FROM app.customers;") thi dong AUDIT cua CA HAI
// cau deu chua nguyen van ca chuoi. Neu di tim chuoi "SET ROLE" trong moi dong
// thi cau SELECT cung bi hieu nham la mot lan doi vai. Vi vay ham nay chi duoc
// goi khi da loc theo class MISC + command SET (xem sessions.js).
const SET_ROLE_RE = /\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+(?:TO\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/i;
const RESET_ROLE_RE = /\bRESET\s+ROLE\b|\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+(?:TO\s+)?NONE\b/i;

function extractRoleChange(statement) {
  if (typeof statement !== 'string') return undefined;
  if (RESET_ROLE_RE.test(statement)) return null;        // null = tro ve session user
  const m = SET_ROLE_RE.exec(statement);
  if (!m) return undefined;                              // undefined = khong phai doi vai
  if (m[1].toUpperCase() === 'NONE') return null;
  return m[1];
}

module.exports = { splitCsv, parseAuditMessage, extractRoleChange };
