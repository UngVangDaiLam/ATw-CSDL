// RULE: truy cap du lieu ngoai gio hanh chinh.
//
// Gio lay tu chinh chuoi timestamp trong log, tuc la theo log_timezone cua
// database (Asia/Ho_Chi_Minh, xem postgresql.conf). Doi log_timezone la doi
// luon y nghia cua rule nay - da ghi trong CLAUDE.md muc "Log".
//
// Chi xet cau lenh cham vao du lieu (READ/WRITE) tren cac bang nhay cam. Cac
// viec nen chay ban dem nhu backup hay bao tri deu di qua superuser/socket va
// da bi loc o tang tren (config.ignoreLocalSocket), nen khong gay bao dong gia.
//
// Diem yeu can biet: rule nay mot minh no rat "on ao" - no danh dau ca hanh vi
// hop le cua nguoi lam ngoai gio. Gia tri cua no nam o cho KET HOP: mot
// FULL_TABLE_READ luc 3 gio sang dang chu y hon nhieu so voi cung cau lenh do
// luc 10 gio sang. Vi vay risk_score de thap (40) va no duoc thiet ke de cong
// don voi rule khac, khong phai de dung mot minh.

const { parseLogTimestamp } = require('../logTime');

module.exports = {
  name: 'AFTER_HOURS',

  run(stmt, config) {
    if (stmt.class !== 'READ' && stmt.class !== 'WRITE') return null;

    const touchesData = stmt.relations.some(
      (r) => config.sensitiveTables.includes(r) || r === config.credentialTable
    );
    if (!touchesData) return null;

    const t = parseLogTimestamp(stmt.timestamp);
    if (!t) return null;

    const { start, end, flagWeekend } = config.businessHours;
    const isWeekend = t.weekday === 0 || t.weekday === 6;
    const outsideHours = t.hour < start || t.hour >= end;

    if (!outsideHours && !(flagWeekend && isWeekend)) return null;

    const lyDo = [];
    if (outsideHours) lyDo.push(`${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} nam ngoai khung ${start}h-${end}h`);
    if (flagWeekend && isWeekend) lyDo.push('roi vao cuoi tuan');

    return {
      rule: 'AFTER_HOURS',
      risk: 40,
      detail: {
        mo_ta: `Truy cap du lieu ngoai gio hanh chinh: ${lyDo.join(', ')}`,
        gio: `${t.hour}:${String(t.minute).padStart(2, '0')}`,
        thu_trong_tuan: t.weekday,
        bang: stmt.relations,
      },
    };
  },
};
