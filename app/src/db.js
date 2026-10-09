require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// TLS toi database, xac thuc server bang CA cua lab (tuong duong
// sslmode=verify-full): kiem chung chi lan ten/IP trong SAN. Chi "require"
// (ma hoa ma khong xac thuc) thi ke xen giua tu ky chung chi la doc duoc het.
// Thieu file CA thi DUNG LAI, khong lui ve ket noi khong ma hoa - pg_hba cung
// se tu choi ket noi do (hostnossl reject).
// Mac dinh: secrets/tls_ca.crt cua repo, de chay tay tren host van dung.
function sslConfig() {
  const caFile = process.env.DB_SSL_ROOT_CERT
    || path.resolve(__dirname, '..', '..', 'secrets', 'tls_ca.crt');
  try {
    return { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  } catch (err) {
    throw new Error(`Khong doc duoc CA TLS ${caFile} (${err.code}). Chay: bash scripts/init-secrets.sh`);
  }
}

// Pool ket noi bang app_user (least privilege) - khong bao gio dung superuser
// hay db_owner. Xem postgres/init/02_roles.sh de biet role nay co quyen gi.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 15432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: sslConfig(),
});

pool.on('error', (err) => {
  console.error('Loi khong mong doi tu pg pool:', err);
});

module.exports = pool;
