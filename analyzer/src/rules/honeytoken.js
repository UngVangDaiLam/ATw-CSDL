// RULE: giai ma trung ban ghi moi (honeytoken).
//
// Vai khach hang gia nam lan trong app.customers, trong y het khach that
// (postgres/init/07_seed.sql PHAN C), ciphertext CCCD cua ho duoc dang ky trong
// audit.honeytokens. Khong nhan vien nao phuc vu nhung nguoi nay, nen KHONG co
// ly do hop le nao de giai ma CCCD cua ho.
//
// Khac voi moi rule con lai, rule nay KHONG doan theo hinh dang cau lenh hay
// nguong so luong:
//   - BULK_DECRYPT can >= 50 ban ghi trong mot cau. Ke tan cong kien nhan rut
//     tung ban ghi mot (do id qua /customers/:id, moi lan mot dong) thi khong
//     bao gio cham nguong. Cham trung MOT moi la du.
//   - Cau lenh hoan toan hop le, quyen hoan toan hop le - lop 1 khong chan,
//     cac rule SQLI_* khong co gi de bat. Day la cach bat ke co quyen that
//     (insider) hoac mat khau app_user bi lo dung psql ket noi thang.
//
// Tin hieu den tu BEN TRONG database: app.decrypt_text() (05_crypto.sql) tu
// nhan ra ciphertext moi va goi audit.honeytoken_tripped() - than ham do la
// mot cau lenh long nhau co dau moc rieng, pgAudit ghi lai. Moi duong
// giai ma deu phai qua ham do (khong role nghiep vu nao co USAGE tren `ext`),
// nen khong co duong vong. Analyzer khong can - va KHONG duoc - doc danh sach
// moi: analyzer_user khong co quyen tren audit.honeytokens (04_grants.sql).
//
// Bao dong gia gan nhu bang 0, nen diem cao nhat bo rule. Dieu kien duy nhat de
// bao nham: nhan vien that mo ho so mot khach moi - va ngay ca khi do, viec mo
// ho so mot nguoi minh khong phuc vu cung dang duoc hoi lai.

module.exports = {
  name: 'HONEYTOKEN_ACCESS',

  run(stmt) {
    if (!stmt.honeytokenHits) return null;

    return {
      rule: 'HONEYTOKEN_ACCESS',
      risk: 98,
      detail: {
        mo_ta: `Giai ma ${stmt.honeytokenHits} ban ghi moi (honeytoken) - khong co ly do hop le de mo cac ban ghi nay`,
        so_ban_ghi_moi: stmt.honeytokenHits,
        so_ban_ghi_giai_ma: stmt.decryptedRows,
        bang: stmt.relations,
      },
    };
  },
};
