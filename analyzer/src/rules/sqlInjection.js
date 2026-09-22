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

  run(stmt) {
    // Chi soi cau lenh doc/ghi du lieu. DDL cua quan tri vien khong tinh.
    if (stmt.class !== 'READ' && stmt.class !== 'WRITE') return null;

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
