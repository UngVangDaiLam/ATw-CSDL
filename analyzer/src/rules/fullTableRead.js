// RULE: doc nguyen bang du lieu nhay cam (khong co dieu kien loc).
//
// GIOI HAN PHAI NOI RO: pgAudit ghi CAU LENH, khong ghi so dong tra ve. Khong
// co cach nao biet chinh xac mot SELECT da lay ve bao nhieu ban ghi chi tu file
// log. Vi vay rule nay khong do "so dong tra ve" ma do HINH DANG cau lenh:
// mot SELECT tren app.customers ma khong he co WHERE thi ve ban chat la yeu cau
// toan bo bang - du nguoi goi co LIMIT hay khong.
//
// Muon do that so dong tra ve thi phai bo sung nguon khac (pg_stat_statements,
// hoac cho ung dung tu ghi so dong da tra). Do la huong mo rong, khong phai thu
// lam duoc bang mot minh pgAudit - ghi vao bao cao dung nhu vay.
//
// Bo qua SELECT count(...): dem so dong la truy van bao cao binh thuong, khong
// lay ra du lieu ca nhan nao.

const COUNT_ONLY_RE = /^\s*select\s+count\s*\(/i;
const HAS_WHERE_RE = /\bwhere\b/i;

module.exports = {
  name: 'FULL_TABLE_READ',

  run(stmt, config) {
    if (stmt.class !== 'READ') return null;

    const hit = stmt.relations.filter((r) => config.sensitiveTables.includes(r));
    if (hit.length === 0) return null;

    if (COUNT_ONLY_RE.test(stmt.statement)) return null;
    if (HAS_WHERE_RE.test(stmt.statement)) return null;

    return {
      rule: 'FULL_TABLE_READ',
      risk: 60,
      detail: {
        mo_ta: 'Doc bang nhay cam ma khong co dieu kien loc',
        bang: hit,
      },
    };
  },
};
