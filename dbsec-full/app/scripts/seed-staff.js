// Tao vai tai khoan nhan vien mau de test dang nhap.
// Chay: node scripts/seed-staff.js  (tu thu muc app/)
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const STAFF = [
  { username: 'nv.hanoi', password: 'Passw0rd!', role: 'sales', branch_ma: 'HN' },
  { username: 'nv.hcm', password: 'Passw0rd!', role: 'sales', branch_ma: 'HCM' },
  { username: 'quanly.hanoi', password: 'Passw0rd!', role: 'manager', branch_ma: 'HN' },
];

async function main() {
  for (const s of STAFF) {
    const branchRes = await pool.query('SELECT id FROM branches WHERE ma_chi_nhanh = $1', [s.branch_ma]);
    if (branchRes.rows.length === 0) {
      console.error(`Khong tim thay chi nhanh ${s.branch_ma}, bo qua ${s.username}`);
      continue;
    }
    const branchId = branchRes.rows[0].id;

    const exists = await pool.query('SELECT id FROM staff WHERE username = $1', [s.username]);
    if (exists.rows.length > 0) {
      console.log(`${s.username} da ton tai, bo qua`);
      continue;
    }

    const hash = await bcrypt.hash(s.password, 10);
    await pool.query(
      'INSERT INTO staff (username, password_hash, role, branch_id) VALUES ($1, $2, $3, $4)',
      [s.username, hash, s.role, branchId]
    );
    console.log(`Da tao ${s.username} / ${s.password} (role=${s.role}, chi nhanh=${s.branch_ma})`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
