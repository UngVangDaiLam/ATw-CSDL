// RULE: doc bang chua thong tin dang nhap tu mot phien nhan vien.
//
// app.staff giu username va password_hash (bcrypt). app_user CO quyen SELECT
// tren toan bo bang nay - bat buoc, vi chinh luong dang nhap phai tra ra
// password_hash de so sanh (app/src/routes/auth.js). Va app.staff KHONG bat
// RLS, nen day la muc tieu that su cua demo SQL Injection: du dang SET ROLE
// sang chi nhanh nao, doc app.staff van ra toan bo nhan vien.
//
// Cach phan biet truy cap hop le voi truy cap dang ngo, KHONG phai bang cau
// lenh ma bang DANH TINH luc chay:
//
//   - Luc dang nhap: app chua biet nguoi dung la ai nen CHUA SET ROLE. Phien
//     con dang la app_user tran -> roleWasSet = false -> bo qua.
//   - Sau khi da SET ROLE sang nv_xxx: nhan vien khong con ly do gi de doc
//     bang nhan vien nua. Doc luc nay la bat thuong -> canh bao.
//
// Dung chinh cai ma lop 1 tao ra (su tach bach giua session user va vai da
// SET ROLE) de phan loai hanh vi - dieu ma nhin vao cot `user` cua log tho
// khong bao gio lam duoc, vi o do moi dong deu la "app_user".

module.exports = {
  name: 'STAFF_CREDENTIAL_READ',

  run(stmt, config) {
    if (stmt.class !== 'READ') return null;
    if (!stmt.relations.includes(config.credentialTable)) return null;

    // Chua SET ROLE -> day la luong dang nhap binh thuong cua ung dung.
    if (!stmt.roleWasSet) return null;

    return {
      rule: 'STAFF_CREDENTIAL_READ',
      risk: 75,
      detail: {
        mo_ta: `Phien da SET ROLE sang ${stmt.actor} nhung van doc ${config.credentialTable} (bang chua password_hash)`,
        bang: stmt.relations,
      },
    };
  },
};
