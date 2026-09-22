// Doc gio tu timestamp cua log PostgreSQL.
//
// Dinh dang: "2026-09-22 20:29:10.435 +07"
//
// CO Y KHONG dung `new Date(...)`: chuoi nay da la GIO DIA PHUONG cua server
// database (postgresql.conf dat log_timezone = 'Asia/Ho_Chi_Minh'), con
// new Date() se quy doi sang mui gio cua may dang chay analyzer. May cua thanh
// vien trong nhom, may cham diem, hay CI deu co the dat mui gio khac - khi do
// rule "truy cap ngoai gio hanh chinh" se lech vai tieng va bao dong sai ma
// khong ai hieu tai sao. Tach truc tiep tu chuoi thi doc dung thu dang nhin
// thay trong file log.
//
// Doi lai: log_timezone PHAI dung. Doi no la doi luon y nghia cua rule
// AFTER_HOURS - xem CLAUDE.md muc "Log".

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/;

function parseLogTimestamp(text) {
  const m = TS_RE.exec(String(text || ''));
  if (!m) return null;

  const [, year, month, day, hour, minute, second] = m.map(Number);

  // Dung Date.UTC roi doc getUTCDay(): chi de tinh thu trong tuan tu 3 so
  // nam/thang/ngay, khong co buoc quy doi mui gio nao ca.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = CN

  return { year, month, day, hour, minute, second, weekday };
}

module.exports = { parseLogTimestamp };
