const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const rlsTransaction = require('../middleware/rls');

const router = express.Router();

// Tu day tro xuong, MOI route trong router nay deu can: da dang nhap
// (requireAuth) VA chay trong 1 transaction rieng co SET LOCAL app.branch_id
// (rlsTransaction) de RLS o tang database loc dung du lieu chi nhanh - xem
// giai thich chi tiet trong middleware/rls.js.
router.use(requireAuth);
router.use(rlsTransaction);

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// GET /customers - danh sach khach hang (parameterized, co phan trang don gian).
// CO Y khong SELECT cot cccd o day (kha nang "masking" don gian: du lieu nhay
// cam chi lo dien khi that su can, o endpoint chi tiet ben duoi) - va tu Task
// 13, RLS da tu dong gioi han chi thay khach hang CUNG chi nhanh voi nguoi
// dang dang nhap, khong can sua logic WHERE thu cong o day.
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  try {
    const result = await req.dbClient.query(
      `SELECT id, ho_ten, email, sdt, dia_chi, branch_id, created_at
       FROM customers
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ status: 'ok', count: result.rows.length, customers: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /customers/search?ten=... - tim khach hang theo ten.
//
// !!! CO Y NOI CHUOI SQL TRUC TIEP O DAY (SQL Injection - Task 10) !!!
// Day la endpoint RIENG, KHAC voi GET /customers o tren (endpoint do van
// parameterized, an toan). Endpoint nay duoc them vao CO Y de demo lo hong
// SQL Injection cho bao cao pentest - khong dung noi chuoi SQL nhu the nay
// trong code that.
//
// Vi du khai thac (dan vao query string ?ten=):
//   ' UNION SELECT id, username, password_hash, role, NULL, branch_id FROM staff -- -
//                             -> lo password_hash cua bang staff qua UNION-based SQLi
// Lop phong thu thuc su: RLS (Task 13, da bat) han che du lieu doc duoc du
// app co loi tang code hay khong - NHUNG chi trong pham vi cac bang co bat
// RLS. Bang "staff" KHONG bat RLS nen UNION-based SQLi van doc duoc no -
// diem quan trong can neu trong bao cao: RLS khong thay the parameterized
// query, chi la lop phong thu bo sung.
router.get('/search', async (req, res) => {
  const ten = req.query.ten || '';
  const sql = `SELECT id, ho_ten, email, sdt, dia_chi, branch_id
               FROM customers
               WHERE ho_ten ILIKE '%${ten}%'
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
// Tu Task 13: giai ma cccd bang pgp_sym_decrypt(cccd, khoa) - khoa CHI nam o
// bien moi truong ENCRYPTION_KEY cua app, khong bao gio luu trong DB. Neu
// truy van bang psql/pgAdmin voi quyen app_user hoac cao hon (khong biet
// khoa), cot cccd van la chuoi bytea vo nghia - dung de chung minh "ke tan
// cong dump duoc DB cung khong doc duoc du lieu nhay cam" trong bao cao.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ status: 'error', message: 'id khong hop le' });
  }

  try {
    const result = await req.dbClient.query(
      `SELECT id, ho_ten, email, sdt, dia_chi, branch_id, created_at,
              pgp_sym_decrypt(cccd, $2) AS cccd
       FROM customers WHERE id = $1`,
      [id, ENCRYPTION_KEY]
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
// Tu Task 13: neu co gui "cccd" trong body, ma hoa bang pgp_sym_encrypt(...)
// truoc khi ghi - KHONG BAO GIO ghi plaintext vao cot nay. pgp_sym_encrypt
// va pgp_sym_decrypt deu la ham STRICT: neu cccd khong duoc gui (undefined ->
// null), ket qua ma hoa tu dong la NULL, khong can if rieng.
router.post('/', async (req, res) => {
  const { ho_ten, email, sdt, dia_chi, branch_id, cccd } = req.body || {};
  if (!ho_ten || !branch_id) {
    return res.status(400).json({ status: 'error', message: 'Thieu ho_ten hoac branch_id' });
  }

  try {
    const result = await req.dbClient.query(
      `INSERT INTO customers (ho_ten, email, sdt, cccd, dia_chi, branch_id)
       VALUES ($1, $2, $3, pgp_sym_encrypt($4, $6), $5, $7)
       RETURNING id, ho_ten, email, sdt, dia_chi, branch_id, created_at`,
      [ho_ten, email || null, sdt || null, cccd || null, dia_chi || null, ENCRYPTION_KEY, branch_id]
    );
    res.status(201).json({ status: 'ok', customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
