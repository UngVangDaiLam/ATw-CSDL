require('dotenv').config();
const { Pool } = require('pg');

// Pool ket noi bang app_user (least privilege) - khong bao gio dung superuser
// hay db_owner. Xem postgres/init/02_roles.sh de biet role nay co quyen gi.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 55432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.on('error', (err) => {
  console.error('Loi khong mong doi tu pg pool:', err);
});

module.exports = pool;
