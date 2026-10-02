// Nhat ky su kien bao mat o TANG WEB.
//
// Analyzer (lop 3) chi doc log pgAudit, ma o tang database thi mot lan dang
// nhap sai trong y het lan dang nhap dung (cung mot cau SELECT tren app.staff).
// Do mat khau bi khoa, request CSRF bi chan... deu xay ra o tang HTTP - khong
// de lai dau vet nao cho lop 3 thay. File nay ghi chung ra mot file JSON Lines
// rieng; analyzer doc file do (chi doc) va ghi canh bao bang analyzer_user.
//
// VI SAO KHONG GHI THANG VAO audit.alerts: app_user co y KHONG co quyen gi tren
// schema audit - app bi chiem thi ke tan cong khong doc, khong xoa duoc bang
// chung (verify.sh co phep thu). Cap INSERT cho app_user la pha nguyen tac do.
//
// KHONG ghi mat khau. Username nguoi dung go vao la du lieu KHONG tin cay: cat
// ngan; analyzer con che chuoi so dai truoc khi ghi canh bao.

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', process.env.APP_LOG_DIR || '../logs/app');
let ready = false;

// Gio Viet Nam, cung khuon voi timestamp trong log PostgreSQL
// ("2026-10-03 01:02:03.456 +07") de analyzer so sanh duoc theo chuoi.
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function vnTimestamp(d = new Date()) {
  return `${fmt.format(d)}.${String(d.getMilliseconds()).padStart(3, '0')} +07`;
}

function clip(v, max = 64) {
  return v == null ? null : String(v).slice(0, max);
}

// Ghi KHONG DONG BO va nuot loi: ghi log hong khong duoc lam hong request.
function securityEvent(event, req, extra = {}) {
  const ts = vnTimestamp();
  const record = {
    ts,
    event,
    // "::ffff:172.28.0.1" -> "172.28.0.1": Node bao IPv4 duoi dang anh xa IPv6.
    ip: String(req.ip || '').replace(/^::ffff:/, ''),
    method: req.method,
    // baseUrl + path: ben trong router (vd. /auth) req.path chi la phan tuong doi.
    path: clip(`${req.baseUrl || ''}${req.path}`, 200),
    staff: req.session?.staff?.db_user || null,
    ...extra,
  };
  const file = path.join(DIR, `security-${ts.slice(0, 10)}.jsonl`);
  const line = `${JSON.stringify(record)}\n`;
  (ready ? Promise.resolve() : fs.promises.mkdir(DIR, { recursive: true }).then(() => { ready = true; }))
    .then(() => fs.promises.appendFile(file, line, 'utf8'))
    .catch((err) => console.error(`[securityLog] khong ghi duoc ${file}: ${err.message}`));
}

module.exports = { securityEvent, clip, SECURITY_LOG_DIR: DIR };
