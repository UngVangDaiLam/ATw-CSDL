// Che du lieu nhay cam TRUOC khi ghi cau lenh vao audit.alerts.
//
// VI SAO CAN: pgaudit.log_parameter = off nen tham so cua prepared statement
// khong bi ghi ("<not logged>"). Nhung gia tri viet THANG vao cau SQL thi van
// nam nguyen trong log:
//
//     SELECT full_name FROM app.customers WHERE cccd_hash = app.blind_index('001201000001');
//
// Do la mot so CCCD o dang ro. Neu analyzer chep nguyen cau lenh vao bang
// audit.alerts thi lop 2 bi thung ngay tai lop 3: so CCCD von duoc ma hoa ky
// trong app.customers lai nam ro trong audit.alerts - mot bang khong he duoc
// ma hoa. Ke tan cong doc duoc bang canh bao se doc luon du lieu that.
//
// Vi vay: chuoi >= 9 chu so lien tiep (CCCD 12 so, so the 16 so, so dien thoai)
// bi thay bang the danh dau. Van du de nguoi doc hieu cau lenh lam gi, nhung
// khong con gia tri that.

const LONG_DIGITS_RE = /\d{9,}/g;

const MAX_LENGTH = 600;

function redactStatement(statement) {
  let text = String(statement || '').replace(LONG_DIGITS_RE, (m) => `<${m.length}_chu_so_da_che>`);

  // Gom khoang trang: cau lenh trong log co the chua xuong dong that, de nguyen
  // thi bang canh bao rat kho doc.
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > MAX_LENGTH) {
    text = `${text.slice(0, MAX_LENGTH)}... <cat bot ${text.length - MAX_LENGTH} ky tu>`;
  }
  return text;
}

module.exports = { redactStatement };
