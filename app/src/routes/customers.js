const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const setRoleTransaction = require('../middleware/setRole');

const router = express.Router();

// Tu day tro xuong, MOI route can: da dang nhap (requireAuth) VA chay trong
// 1 transaction rieng co SET LOCAL ROLE nv_xxx (setRoleTransaction) de RLS o
// tang database loc dung du lieu chi nhanh - xem middleware/setRole.js.
router.use(requireAuth);
router.use(setRoleTransaction);

// GET /customers - danh sach khach hang (parameterized, phan trang don gian).
// CO Y khong SELECT cot cccd o day - du lieu nhay cam chi lo dien khi that
// su can (endpoint chi tiet ben duoi). RLS da tu dong gioi han chi thay
// khach hang CUNG chi nhanh voi nguoi dang dang nhap, khong can sua WHERE
// thu cong o day.
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  try {
    const result = await req.dbClient.query(
      `SELECT id, full_name, email, phone, branch_id, created_at
       FROM app.customers
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ status: 'ok', count: result.rows.length, customers: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /customers/search?name=... - tim khach hang theo ten.
//
// !!! CO Y NOI CHUOI SQL TRUC TIEP O DAY (SQL Injection - demo pentest) !!!
// Endpoint RIENG, KHAC voi GET /customers o tren (endpoint do parameterized,
// an toan). Duoc giu lai CO Y de demo lo hong cho bao cao - KHONG noi chuoi
// SQL nhu the nay trong code that.
//
// Vi du khai thac (dan vao query string ?name=):
//   ' UNION SELECT id, username, password_hash, db_user, branch_id FROM app.staff -- -
//                             -> lo password_hash cua app.staff qua UNION-based SQLi
//
// Lop phong thu thuc su: RLS (postgres/init/06_rls.sql) han che du lieu doc
// duoc du app co loi tang code hay khong - NHUNG chi trong pham vi cac bang
// co bat RLS (customers/orders/payments). Bang app.staff KHONG bat RLS
// (CLAUDE.md: "chỉ RLS trên customers/orders/payments") nen UNION-based SQLi
// van doc duoc no - diem quan trong can neu trong bao cao: RLS khong thay
// the parameterized query, chi la lop phong thu bo sung.
router.get('/search', async (req, res) => {
  const name = req.query.name || '';
  const sql = `SELECT id, full_name, email, phone, branch_id
               FROM app.customers
               WHERE full_name ILIKE '%${name}%'
               ORDER BY id
               LIMIT 100`;
  try {
    const result = await req.dbClient.query(sql);
    res.json({ status: 'ok', count: result.rows.length, customers: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /customers/:id - chi tiet 1 khach hang (parameterized).
// Giai ma cccd qua app.decrypt_text(bytea) - HAM BOC SAN, khong bao gio goi
// truc tiep pgp_sym_decrypt hay tu truyen khoa: app/ khong he biet khoa nam
// o dau (postgres/init/05_crypto.sql). Neu dump duoc DB hoac truy van bang
// mot role khong biet goi ham nay, cot cccd van la bytea vo nghia.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ status: 'error', message: 'id khong hop le' });
  }

  try {
    const result = await req.dbClient.query(
      `SELECT id, full_name, email, phone, branch_id, created_at,
              app.decrypt_text(cccd) AS cccd
       FROM app.customers WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Khong tim thay khach hang' });
    }
    res.json({ status: 'ok', customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /customers - tao khach hang moi (parameterized).
// branch_id LAY TU SESSION cua nguoi dang nhap, khong nhan tu body - nhan
// vien chi tao duoc khach hang cho chi nhanh minh. RLS (WITH CHECK) la lop
// chan thu hai neu logic nay o app bi sua sai trong tuong lai.
// cccd (neu co gui) duoc ma hoa bang app.encrypt_text() truoc khi ghi, kem
// app.blind_index() de tra cuu sau nay - KHONG BAO GIO ghi plaintext.
router.post('/', async (req, res) => {
  const { full_name, email, phone, cccd } = req.body || {};
  const branchId = req.session.staff.branch_id;
  if (!full_name || !branchId) {
    return res.status(400).json({ status: 'error', message: 'Thieu full_name hoac chua xac dinh duoc chi nhanh' });
  }

  try {
    const result = await req.dbClient.query(
      `INSERT INTO app.customers (branch_id, full_name, email, phone, cccd, cccd_hash)
       VALUES ($1, $2, $3, $4, app.encrypt_text($5), app.blind_index($5))
       RETURNING id, full_name, email, phone, branch_id, created_at`,
      [branchId, full_name, email || null, phone || null, cccd || null]
    );
    res.status(201).json({ status: 'ok', customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
