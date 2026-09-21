const express = require('express');
const session = require('express-session');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');

const app = express();
app.use(express.json());

// Session luu trong memory - du dung cho demo. Khong dung trong production
// (mat session khi restart, khong scale duoc nhieu instance).
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'doi_chuoi_bi_mat_nay',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 }, // 1 gio
  })
);

// Endpoint kiem tra: ket noi DB co song khong, va dang dung dung user nao.
// current_user phai la "app_user", KHONG duoc la "dbsec_admin".
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT current_user, current_database(), now() AS server_time'
    );
    res.json({ status: 'ok', ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/auth', authRoutes);
app.use('/customers', customerRoutes);
app.use('/orders', orderRoutes);

module.exports = app;
