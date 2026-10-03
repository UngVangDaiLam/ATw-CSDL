// RULE: cau lenh bi PostgreSQL tu choi quyen (SQLSTATE 42501).
//
// Lop 1 chan duoc thi du lieu an toan, nhung hanh vi THU van la bang chung:
// mot phien ung dung binh thuong khong bao gio cham vao thu no khong co quyen.
// Vi du dien hinh la SQLi UNION o /customers/search doc app.staff.password_hash
// - truoc day thanh cong, gio app_user/staff_role khong co quyen tren cot do
// (postgres/init/04_grants.sql) nen cau lenh loi ngay tai server.
//
// pgAudit KHONG ghi dong AUDIT cho cau lenh bi tu choi quyen (kiem tra quyen
// chay truoc hook cua no). sessions.js vi vay bat rieng dong ERROR co
// state_code 42501 va dua vao day voi class 'DENIED'. Cau lenh di kem van qua
// redact.js nhu moi canh bao khac.
//
// Diem cao hon khi nham vao thong tin dang nhap (bang app.staff / cot
// password_hash): do la buoc dau cua chiem tai khoan, khong phai lo tay.

const CREDENTIAL_RE = /password_hash/i;

module.exports = {
  name: 'ACCESS_DENIED',

  run(stmt, config) {
    if (stmt.class !== 'DENIED') return null;

    const credTable = config.credentialTable.split('.').pop();
    const credential =
      CREDENTIAL_RE.test(stmt.statement) ||
      new RegExp(`\\b${credTable}\\b`, 'i').test(stmt.deniedMessage || '');

    return {
      rule: 'ACCESS_DENIED',
      risk: credential ? 85 : 65,
      detail: {
        mo_ta: credential
          ? `Bi tu choi khi doc thong tin dang nhap (${config.credentialTable}) - lop 1 da chan, day la dau vet cua lan thu`
          : 'Cau lenh bi tu choi quyen - phien ung dung dang thu cham vao thu no khong duoc phep',
        loi: String(stmt.deniedMessage || '').slice(0, 200),
      },
    };
  },
};
