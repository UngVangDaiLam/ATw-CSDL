// Task 13 - middleware gan 1 ket noi DB RIENG cho tung request (checkout tu
// pool), mo transaction, va set session variable "app.branch_id" (RLS trong
// db/init/04-app-rls.sql doc gia tri nay de loc du lieu theo chi nhanh).
//
// LY DO PHAI LAM VIEC NAY O DAY (khong dung pool.query() truc tiep trong
// route nhu cac Task truoc): app dung CONNECTION POOL - pool.query() moi lan
// goi co the "muon" mot ket noi vat ly BAT KY trong pool, dung xong tra lai.
// Neu dung "SET app.branch_id" (khong phai SET LOCAL) tren mot ket noi roi
// tra no lai pool, request TIEP THEO dung lai dung ket noi vat ly do co the
// vo tinh "thua ke" gia tri branch_id cu cua request truoc - ro ri du lieu
// giua cac request. Vi vay o day:
//   1) Xin HAN CHE 1 ket noi rieng cho ca vong doi request (pool.connect()).
//   2) Dung SET LOCAL (qua ham set_config voi tham so thu 3 = true) - chi co
//      hieu luc trong PHAM VI TRANSACTION hien tai, tu dong het hieu luc khi
//      COMMIT/ROLLBACK, khong the "ri" sang request khac du dung lai ket noi.
//   3) Dung set_config('app.branch_id', $1, true) thay vi noi chuoi
//      "SET LOCAL app.branch_id = " + branchId - vi cau lenh SET/SET LOCAL
//      thong thuong KHONG ho tro tham so ($1) trong giao thuc parameterized
//      query cua PostgreSQL, con set_config() la 1 ham binh thuong nen van
//      dung duoc tham so an toan nhu moi query khac.
//
// Middleware nay PHAI dat SAU requireAuth trong chuoi middleware (can
// req.session.staff.branch_id da duoc dang nhap set san).
const pool = require('../db');

async function rlsTransaction(req, res, next) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const branchId = req.session?.staff?.branch_id;
    if (Number.isInteger(branchId)) {
      await client.query("SELECT set_config('app.branch_id', $1, true)", [String(branchId)]);
    }
    // Neu khong co branchId hop le (khong nen xay ra vi requireAuth da chan
    // truoc do), CO Y khong set app.branch_id - RLS se mac dinh KHONG cho
    // thay row nao (fail closed), an toan hon la lo du lieu.

    req.dbClient = client;
  } catch (err) {
    if (client) client.release();
    return res.status(500).json({ status: 'error', message: err.message });
  }

  res.on('finish', () => {
    const finalize = res.statusCode >= 400 ? 'ROLLBACK' : 'COMMIT';
    client
      .query(finalize)
      .catch((err) => console.error(`Loi ${finalize} transaction RLS:`, err.message))
      .finally(() => client.release());
  });

  next();
}

module.exports = rlsTransaction;
