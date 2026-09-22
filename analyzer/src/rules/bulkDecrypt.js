// RULE: giai ma hang loat - noi lop 2 voi lop 3.
//
// Day la rule chi ton tai duoc nho cach lop 2 duoc thiet ke. Vi khoa nam trong
// Docker secret va khong role nghiep vu nao co USAGE tren schema ext
// (04_grants.sql), moi lan giai ma BAT BUOC phai di qua app.decrypt_text() -
// mot ham SECURITY DEFINER co ten ro rang. Neu ung dung duoc cam khoa va tu goi
// pgp_sym_decrypt thi hanh vi nay se tan ra thanh nhieu hinh dang khac nhau va
// gan nhu khong the dem duoc.
//
// CACH DEM: than ham SQL duoc pgAudit ghi lai nhu cau lenh long nhau
// (substatement_id > 1) - sessions.js dem so lan than ham co chua
// pgp_sym_decrypt trong pham vi MOT cau lenh client. Con so do chinh la SO BAN
// GHI da bi giai ma. Khong phai uoc luong: mot lan goi ham la mot ban ghi.
//
// Vi the day la rule DUY NHAT trong bo nay biet duoc khoi luong that su lay ra,
// thay vi chi doan qua hinh dang cau lenh nhu FULL_TABLE_READ.
//
// Mot nhan vien mo ho so tung khach hang thi con so nay la 1. Mot cau
// "SELECT app.decrypt_text(cccd) FROM app.customers" quet ca bang se cho ra
// hang nghin - va do la dinh nghia cua rut du lieu hang loat.

module.exports = {
  name: 'BULK_DECRYPT',

  run(stmt, config) {
    if (stmt.decryptedRows < config.bulkDecryptThreshold) return null;

    return {
      rule: 'BULK_DECRYPT',
      // Rieng rule nay do duoc khoi luong that nen diem rui ro tang theo so
      // ban ghi, chan tren 95 de con cho cho canh bao nghiem trong hon.
      risk: Math.min(95, 70 + Math.floor(stmt.decryptedRows / 100)),
      detail: {
        mo_ta: `Mot cau lenh giai ma ${stmt.decryptedRows} ban ghi (nguong ${config.bulkDecryptThreshold})`,
        so_ban_ghi_giai_ma: stmt.decryptedRows,
        bang: stmt.relations,
      },
    };
  },
};
