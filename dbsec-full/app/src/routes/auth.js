const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

// POST /auth/login - xac thuc bang username/password, luu thong tin nhan
// vien vao session (id, role, branch_id). Day la parameterized query -
// KHONG noi chuoi SQL truc tiep (khac voi endpoint tim kiem se lam o Task 10).
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Thieu username/password' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, password_hash, role, branch_id FROM staff WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Sai username hoac password' });
    }

    const staff = result.rows[0];
    const ok = await bcrypt.compare(password, staff.password_hash);
    if (!ok) {
      return res.status(401).json({ status: 'error', message: 'Sai username hoac password' });
    }

    req.session.staff = {
      id: staff.id,
      username: staff.username,
      role: staff.role,
      branch_id: staff.branch_id,
    };

    res.json({ status: 'ok', staff: req.session.staff });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /auth/me - xem dang dang nhap la ai (dung de test session hoat dong)
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
