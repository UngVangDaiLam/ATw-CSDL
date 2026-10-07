// RULE: mang vai nhan vien ma khong co phien dang nhap cua nhan vien do.
//
// App dung MOT pool app_user roi SET LOCAL ROLE nv_xxx, nen app_user phai la
// thanh vien cua moi role nv_*. Quyen thanh vien thi PostgreSQL cho phep, nen
// "SET ROLE nv_dn01" luon thanh cong - ke cam duoc mat khau app_user, hay mot
// loi o tang app, deu lam duoc. Truoc day day la gioi han "khong the go neu
// van dung pool chung".
//
// Nay RLS doi them token phien dang nhap cua chinh nhan vien do
// (postgres/init/06_rls.sql, app.current_branch_id): token chi cap khi nhap dung mat
// khau nhan vien. Thieu token, token cua nguoi khac, hay token het han -> doc ra
// 0 dong, va ham ghi mot dong LOG ma nguoi goi khong nhin thay. sessions.js
// bien dong do thanh stmt.identity.
//
// Canh bao quy cho SESSION USER (app_user), khong quy cho nv_xxx: nhan vien
// bi mao danh khong lam gi ca. Ten vai nam o detail.vai_khong_co_phien, IP
// nguon o detail.client - phien that cua app luon di tu 172.28.0.20.
//
// token_het_han, nhan_vien_bi_khoa: nguoi dung rat co the la chinh nhan vien
// do (lam qua ca; bi khoa giua ca ma phien web van mo) - diem thap hon, va
// sessions.js KHONG coi la mao danh nen canh bao van quy cho nhan vien. Ba ly
// do con lai khong co cach giai thich hop le nao.

const REASONS = {
  khong_co_token: { risk: 90, mo_ta: 'SET ROLE sang vai nhan vien ma khong co token phien dang nhap' },
  token_khong_ton_tai: { risk: 90, mo_ta: 'Mang token phien khong ton tai (doan, hoac token da thu hoi khi dang xuat)' },
  token_cua_nguoi_khac: { risk: 95, mo_ta: 'Mang token phien cua MOT NHAN VIEN KHAC voi vai dang SET ROLE' },
  token_het_han: { risk: 50, mo_ta: 'Token phien da het han (qua 12 gio) - co the la nhan vien lam qua ca' },
  nhan_vien_bi_khoa: { risk: 70, mo_ta: 'Nhan vien DA BI KHOA van dung token phien cu' },
};

module.exports = {
  name: 'IDENTITY_WITHOUT_SESSION',

  run(stmt) {
    if (!stmt.identity) return null;
    const r = REASONS[stmt.identity.reason] || { risk: 90, mo_ta: 'Vai nhan vien khong khop phien dang nhap' };

    return {
      rule: 'IDENTITY_WITHOUT_SESSION',
      risk: r.risk,
      detail: {
        mo_ta: `${r.mo_ta}: ${stmt.identity.role} - RLS tra 0 dong`,
        ly_do: stmt.identity.reason,
        bang: stmt.relations,
      },
    };
  },
};
