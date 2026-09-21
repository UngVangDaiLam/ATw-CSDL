const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const setRoleTransaction = require('../middleware/setRole');

const router = express.Router();

router.use(requireAuth);
router.use(setRoleTransaction);

// GET /orders - danh sach don hang (parameterized)
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  try {
    const result = await req.dbClient.query(
      `SELECT o.id, o.customer_id, c.full_name AS customer_name, o.order_no,
              o.total_amount, o.status, o.created_at
       FROM app.orders o
       JOIN app.customers c ON c.id = o.customer_id
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
// !!! CO Y KHONG KIEM TRA QUYEN O DAY (IDOR - demo pentest) !!!
// Endpoint nay CO Y khong kiem tra don hang co thuoc chi nhanh cua nguoi
// dang dang nhap hay khong - code app "quen" kiem tra nay CO Y GIU NGUYEN.
// Diem quan trong cho demo/bao cao: RLS o tang database (branch_isolation
// policy tren app.orders, postgres/init/06_rls.sql) van tu dong chan khong
// cho doc don hang ngoai chi nhanh cua current_branch_id() - minh chung cho
// luan diem "defense-in-depth": voi id thuoc chi nhanh khac, endpoint nay
// tra ve 404 (RLS loc mat row truoc khi app kip doc) du code khong kiem tra
// quyen mot dong nao.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ status: 'error', message: 'id khong hop le' });
  }

  try {
    const result = await req.dbClient.query(
      `SELECT o.id, o.customer_id, c.full_name AS customer_name, o.branch_id,
              o.order_no, o.total_amount, o.status, o.created_at
       FROM app.orders o
       JOIN app.customers c ON c.id = o.customer_id
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

// POST /orders - tao don hang moi (parameterized).
// branch_id LAY TU SESSION, khong nhan tu body, cung ly do nhu POST
// /customers. order_no sinh tu server, khong nhan tu client.
router.post('/', async (req, res) => {
  const { customer_id, total_amount } = req.body || {};
  const branchId = req.session.staff.branch_id;
  if (!customer_id || total_amount === undefined) {
    return res.status(400).json({ status: 'error', message: 'Thieu customer_id hoac total_amount' });
  }

  const orderNo = `ORD-${Date.now()}`;

  try {
    const result = await req.dbClient.query(
      `INSERT INTO app.orders (customer_id, branch_id, order_no, total_amount)
       VALUES ($1, $2, $3, $4)
       RETURNING id, customer_id, branch_id, order_no, total_amount, status, created_at`,
      [customer_id, branchId, orderNo, total_amount]
    );
    res.status(201).json({ status: 'ok', order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
