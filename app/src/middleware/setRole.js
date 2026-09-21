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
// Middleware nay PHAI dat SAU requireAuth trong chuoi middleware (can
// req.session.staff.db_user da duoc dang nhap set san).
const pool = require('../db');

const DB_USER_RE = /^[a-z][a-z0-9_]*$/;

async function setRoleTransaction(req, res, next) {
  const dbUser = req.session?.staff?.db_user;
  if (!dbUser || !DB_USER_RE.test(dbUser)) {
    return res.status(403).json({ status: 'error', message: 'Tai khoan khong gan voi role CSDL hop le' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Khong the dung $1 cho ten role trong SET LOCAL ROLE, xem giai thich o
    // tren. dbUser da qua whitelist regex nen an toan de noi chuoi truc tiep.
    await client.query(`SET LOCAL ROLE ${dbUser}`);
    req.dbClient = client;
  } catch (err) {
    if (client) client.release();
    return res.status(500).json({ status: 'error', message: err.message });
  }

  res.on('finish', () => {
    const finalize = res.statusCode >= 400 ? 'ROLLBACK' : 'COMMIT';
    client
      .query(finalize)
      .catch((err) => console.error(`Loi ${finalize} transaction:`, err.message))
      .finally(() => client.release());
  });

  next();
}

module.exports = setRoleTransaction;
