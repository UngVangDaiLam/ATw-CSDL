const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const rlsTransaction = require('../middleware/rls');

const router = express.Router();

// Tu Task 13: moi route deu chay trong 1 transaction rieng co SET LOCAL
// app.branch_id (rlsTransaction) - xem middleware/rls.js. RLS tren bang
// orders (db/init/04-app-rls.sql) loc theo branch_id CUA KHACH HANG gan voi
// don hang (qua customer_id), khong can sua logic WHERE thu cong o day.
router.use(requireAuth);
router.use(rlsTransaction);

// GET /orders - danh sach don hang (parameterized)
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  try {
    const result = await req.dbClient.query(
      `SELECT o.id, o.customer_id, c.ho_ten AS customer_ten, o.tong_tien, o.trang_thai, o.created_at
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ORDER BY o.id
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ status: 'ok', count: result.rows.length, orders: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /orders/:id - chi tiet 1 don hang.
//
// !!! CO Y KHONG KIEM TRA QUYEN O DAY (IDOR - Task 10) !!!
// Endpoint nay CHU Y khong kiem tra don hang co thuoc chi nhanh/khach hang
// cua nguoi dang dang nhap hay khong - code app VAN CON lo hong nay y nguyen
// (khong sua). Diem quan trong cho demo/bao cao: TU Task 13, du code app van
// "quen" kiem tra, RLS o tang database van tu dong chan khong cho doc don
// hang ngoai chi nhanh - chinh la minh chung cho luan diem "defense-in-depth"
// cua do an. Truoc Task 13, doi voi id thuoc chi nhanh khac endpoint nay tra
// ve 200 + du lieu; tu Task 13, cung id do se tra ve 404 (RLS loc mat row
// truoc khi app kip doc) du code khong doi mot dong nao.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ status: 'error', message: 'id khong hop le' });
  }

  try {
    const result = await req.dbClient.query(
      `SELECT o.id, o.customer_id, c.ho_ten AS customer_ten, c.branch_id,
              o.tong_tien, o.trang_thai, o.created_at
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Khong tim thay don hang' });
    }
    res.json({ status: 'ok', order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /orders - tao don hang moi (parameterized)
router.post('/', async (req, res) => {
  const { customer_id, tong_tien } = req.body || {};
  if (!customer_id || tong_tien === undefined) {
    return res.status(400).json({ status: 'error', message: 'Thieu customer_id hoac tong_tien' });
  }

  try {
    const result = await req.dbClient.query(
      `INSERT INTO orders (customer_id, tong_tien)
       VALUES ($1, $2)
       RETURNING id, customer_id, tong_tien, trang_thai, created_at`,
      [customer_id, tong_tien]
    );
    res.status(201).json({ status: 'ok', order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
