const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

// POST /auth/login - xac thuc bang username/password (parameterized query -
// KHONG noi chuoi truc tiep, khac voi GET /customers/search o duoi).
//
// Dung pool.query() thang (khong SET ROLE) vi luc nay CHUA biet dang nhap
// thanh cong hay chua, va app_user von da co SELECT tren toan bo app.staff
// (postgres/init/04_grants.sql) - du de tra username/password_hash/db_user.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Thieu username/password' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, password_hash, db_user, branch_id, full_name
       FROM app.staff
       WHERE username = $1 AND is_active`,
      [username]
    );

    if (result.rows.length === 0 || !result.rows[0].password_hash) {
      return res.status(401).json({ status: 'error', message: 'Sai username hoac password' });
    }

    const staff = result.rows[0];
    const ok = await bcrypt.compare(password, staff.password_hash);
    if (!ok) {
      return res.status(401).json({ status: 'error', message: 'Sai username hoac password' });
    }

    // db_user (vd 'nv_hn01') la thu duy nhat middleware/setRole.js can - day
    // chinh la cau noi giua "nhan vien nao dang nhap" va "role PostgreSQL nao
    // se SET LOCAL ROLE sang cho request tiep theo".
    req.session.staff = {
      id: staff.id,
      username: staff.username,
      db_user: staff.db_user,
      branch_id: staff.branch_id,
      full_name: staff.full_name,
    };

    res.json({ status: 'ok', staff: req.session.staff });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /auth/me - xem dang dang nhap la ai (test session hoat dong)
router.get('/me', (req, res) => {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ status: 'error', message: 'Chua dang nhap' });
  }
  res.json({ status: 'ok', staff: req.session.staff });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ status: 'ok' });
  });
});

module.exports = router;
