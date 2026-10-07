// Middleware gan MOT ket noi DB rieng cho tung request (checkout tu pool), mo
// transaction, va "SET LOCAL ROLE nv_xxx" - day la co che dinh danh cho RLS
// cua repo nay (khac voi ban goc dung "SET LOCAL app.branch_id" qua
// set_config): xem postgres/init/06_rls.sql va CLAUDE.md muc "RLS".
//
// LY DO PHAI GAN 1 KET NOI RIENG (khong dung pool.query() truc tiep trong
// route): app dung CONNECTION POOL - pool.query() moi lan goi co the "muon"
// mot ket noi vat ly BAT KY trong pool roi tra lai. Neu dung "SET ROLE" tran
// (khong phai SET LOCAL) tren mot ket noi roi tra no lai pool, request TIEP
// THEO dung lai dung ket noi do se "thua ke" danh tinh cua request truoc -
// lo hong nghiem trong va rat kho tai hien vi chi xay ra khi pool tai su
// dung connection. Vi vay o day:
//   1) Xin HAN CHE 1 ket noi rieng cho ca vong doi request (pool.connect()).
//   2) Dung SET LOCAL ROLE trong BEGIN...COMMIT/ROLLBACK - tu het hieu luc khi
//      ket thuc transaction, khong the "ri" sang request khac.
//
// KHONG dung tham so hoa duoc cho SET LOCAL ROLE (giao thuc parameterized
// query cua PostgreSQL khong ho tro tham so cho cau SET), nen phai noi chuoi
// ten role vao cau lenh. An toan vi db_user KHONG phai input tu client - no
// duoc tra tu app.staff.db_user luc dang nhap (routes/auth.js) roi luu vao
// session phia server, khong phai gia tri client tu dien gui len. Van kiem
// tra lai bang whitelist regex o day nhu mot lop phong ve sau cung.
//
// TOKEN PHIEN: SET LOCAL ROLE thoi la CHUA DU de thay du lieu. app_user la
// thanh vien cua moi role nv_*, nen RLS con doi token phien dang nhap cua
// chinh nhan vien do (postgres/init/06_rls.sql, app.branch_of). Token do
// app.verify_staff_login() cap luc dang nhap (routes/auth.js), luu trong
// session PHIA SERVER (req.session.dbToken) - KHONG nam trong req.session.staff
// vi doi tuong do duoc tra ve client o /auth/me.
// Token PHAI di qua tham so $1 cua set_config(): noi chuoi vao cau SQL la no
// nam nguyen van trong log pgAudit (log_parameter = off chi che tham so).
//
// Middleware nay PHAI dat SAU requireAuth trong chuoi middleware (can
// req.session.staff.db_user da duoc dang nhap set san).
const pool = require('../db');
const { serverError } = require('../errors');

const DB_USER_RE = /^[a-z][a-z0-9_]*$/;

// Token phien het han cung sau 12 gio (app.staff_sessions.expires_at,
// postgres/init/03_schema.sql), con cookie phien web thi tu gia han theo hoat
// dong (rolling, src/app.js). Khong chan o day thi nguoi lam qua 12 gio van
// "dang nhap" nhung moi danh sach rong (RLS tra 0 dong) va moi request ghi mot
// canh bao IDENTITY_WITHOUT_SESSION. Dung truoc han 5 phut cho khoi lech gio.
const DB_TOKEN_TTL_MS = (12 * 60 - 5) * 60 * 1000;

async function setRoleTransaction(req, res, next) {
  const dbUser = req.session?.staff?.db_user;
  if (!dbUser || !DB_USER_RE.test(dbUser)) {
    return res.status(403).json({ status: 'error', message: 'Tai khoan khong gan voi role CSDL hop le' });
  }
  const dbToken = req.session.dbToken;
  if (typeof dbToken !== 'string' || dbToken.length === 0) {
    // Phien tao truoc khi co token phien (app vua nang cap): bat dang nhap lai.
    return res.status(401).json({ status: 'error', message: 'Phien dang nhap khong con hop le, hay dang nhap lai' });
  }
  if (!(Date.now() - (req.session.loginAt || 0) < DB_TOKEN_TTL_MS)) {
    return req.session.destroy(() => {
      res.status(401).json({ status: 'error', message: 'Phien dang nhap da het han (12 gio), hay dang nhap lai' });
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Khong the dung $1 cho ten role trong SET LOCAL ROLE, xem giai thich o
    // tren. dbUser da qua whitelist regex nen an toan de noi chuoi truc tiep.
    await client.query(`SET LOCAL ROLE ${dbUser}`);
    // is_local = true: het hieu luc o COMMIT/ROLLBACK cung voi vai, khong ri
    // sang request khac dung lai ket noi nay.
    await client.query("SELECT set_config('secdb.staff_token', $1, true)", [dbToken]);
    req.dbClient = client;
  } catch (err) {
    if (client) client.release();
    return serverError(res, err, 'SET LOCAL ROLE');
  }

  res.on('finish', () => {
    const finalize = res.statusCode >= 400 ? 'ROLLBACK' : 'COMMIT';
    client
      .query(finalize)
      .catch((err) => console.error(`Loi ${finalize} transaction:`, err.message))
      // SET LOCAL ROLE da tu het hieu luc o COMMIT/ROLLBACK, nen RESET ROLE
      // KHONG doi gi trong database. No o day cho LOP 3: pgAudit khong ghi
      // COMMIT, nen analyzer khong biet vai da het. Ket noi tra ve pool roi
      // duoc request sau dung lai - vd. luong dang nhap (pool.query doc
      // app.staff, khong SET ROLE) - thi analyzer quy cau do cho nhan vien cua
      // request TRUOC, sinh canh bao STAFF_CREDENTIAL_READ gia gan nham nguoi.
      // RESET ROLE vao log (class misc_set) la dau moc de analyzer tra vai.
      // Dung bo dong nay.
      .then(() => client.query('RESET ROLE'))
      .catch((err) => console.error('Loi RESET ROLE:', err.message))
      .finally(() => client.release());
  });

  next();
}

module.exports = setRoleTransaction;
