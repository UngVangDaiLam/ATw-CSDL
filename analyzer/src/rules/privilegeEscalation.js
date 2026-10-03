// RULE: leo thang dac quyen / go bo lop bao ve ngay trong database.
//
// Kich ban: ke tan cong chiem duoc admin_user (hoac db_owner) - hai role nay
// dang nhap duoc qua TCP (pg_hba.conf). admin_user khong phai superuser, nhung
// SET ROLE db_owner la thanh chu so huu moi bang, va chu so huu thi:
//   - tat duoc RLS (DISABLE / NO FORCE ROW LEVEL SECURITY), xoa duoc policy;
//   - GRANT duoc quyen tren bang cho PUBLIC hay cho app_user;
//   - tao duoc ham SECURITY DEFINER lam cua hau;
//   - dat ALTER DEFAULT PRIVILEGES ... ON TABLES - dung thu repo co y tranh.
// Khong can khai thac lo hong nao: day la nhung cau lenh hop le, chi co the
// phat hien bang cach doc log. pgAudit da ghi chung (class `role` + `ddl` trong
// pgaudit.log) - rule nay goi ten chung.
//
// Cac buoc vuot quyen han cua role (ALTER ROLE ... SUPERUSER, GRANT db_owner TO
// app_user) thi bi PostgreSQL tu choi - khong co dong AUDIT, chi co dong ERROR
// 42501. sessions.js dua chung vao day voi class 'DENIED' (xem accessDenied.js),
// nen lan THU leo thang cung bi goi ten, khong chi lan thanh cong.
//
// GIOI HAN: phien qua unix socket bi bo qua (config.ignoreLocalSocket) - do la
// duong cua superuser trong container. Ai da co shell trong container database
// thi da vuot ra ngoai mo hinh nay; muon soi ca duong do thi dat
// IGNORE_LOCAL_SOCKET=false.
//
// LUU Y KHI DOI CHIEU: client gui nhieu cau trong MOT chuoi thi dong AUDIT cua
// moi cau deu chua nguyen ca chuoi (CLAUDE.md muc "Log"). Vi vay moi mau deu
// gan voi `command` cua chinh dong do, khong chi tim chuoi trong cau lenh.

const PATTERNS = [
  {
    loai: 'thuoc tinh role nguy hiem',
    commands: ['ALTER ROLE', 'CREATE ROLE'],
    // \b truoc ten thuoc tinh: "NOSUPERUSER" khong khop, vi giua O va S khong
    // co ranh gioi tu.
    re: /\b(SUPERUSER|CREATEROLE|CREATEDB|BYPASSRLS|REPLICATION)\b/i,
    risk: 95,
    mo_ta: 'Gan thuoc tinh dac quyen cho role (SUPERUSER / CREATEROLE / BYPASSRLS...)',
  },
  {
    loai: 'tat giam sat',
    commands: ['SET', 'ALTER SYSTEM', 'ALTER ROLE', 'ALTER DATABASE'],
    re: /\bpgaudit\./i,
    risk: 95,
    mo_ta: 'Thay doi cau hinh pgAudit - xoa dau vet cua lop giam sat',
  },
  {
    loai: 'cap role thanh vien',
    commands: ['GRANT ROLE'],
    re: /\bGRANT\b/i,
    risk: 90,
    mo_ta: 'Cap role cho role khac (GRANT <role> TO ...) - thua ke quyen cua role do',
  },
  {
    loai: 'tat RLS',
    commands: ['ALTER TABLE'],
    re: /\b(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i,
    risk: 90,
    mo_ta: 'Tat Row-Level Security - bo loc theo chi nhanh mat hieu luc',
  },
  {
    loai: 'xoa/sua policy RLS',
    commands: ['DROP POLICY', 'ALTER POLICY'],
    re: /\bPOLICY\b/i,
    risk: 85,
    mo_ta: 'Xoa hoac sua policy RLS',
  },
  {
    loai: 'cap quyen cho PUBLIC',
    commands: ['GRANT'],
    re: /\bTO\s+PUBLIC\b/i,
    risk: 85,
    mo_ta: 'Cap quyen cho PUBLIC - moi role, ke ca role tao sau nay, deu co quyen',
  },
  {
    loai: 'ham SECURITY DEFINER',
    commands: ['CREATE FUNCTION', 'ALTER FUNCTION', 'CREATE PROCEDURE', 'ALTER PROCEDURE'],
    re: /\bSECURITY\s+DEFINER\b/i,
    risk: 80,
    mo_ta: 'Tao/sua ham SECURITY DEFINER - ham chay duoi quyen chu so huu, co the la cua hau',
  },
  {
    loai: 'default privileges cho bang',
    commands: ['ALTER DEFAULT PRIVILEGES'],
    re: /\bGRANT\b[\s\S]*\bON\s+TABLES\b/i,
    risk: 75,
    mo_ta: 'ALTER DEFAULT PRIVILEGES ... ON TABLES - bang tao sau nay tu dong duoc cap quyen (pha mo hinh whitelist)',
  },
];

const CLASSES = new Set(['ROLE', 'DDL', 'MISC', 'DENIED']);

module.exports = {
  name: 'PRIVILEGE_ESCALATION',

  run(stmt) {
    if (!CLASSES.has(stmt.class)) return null;
    const command = String(stmt.command || '').toUpperCase();

    const p = PATTERNS.find((x) => x.commands.includes(command) && x.re.test(stmt.statement));
    if (!p) return null;

    const denied = stmt.class === 'DENIED';
    return {
      rule: 'PRIVILEGE_ESCALATION',
      risk: p.risk,
      detail: {
        mo_ta: `${p.loai}${denied ? ' (BI TU CHOI)' : ''}: ${p.mo_ta}`,
        loai: p.loai,
        bi_tu_choi: denied,
      },
    };
  },
};
