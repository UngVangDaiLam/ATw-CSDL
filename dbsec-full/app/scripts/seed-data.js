// Seed du lieu customers/orders/payments bang Faker.js, rai deu cho 3 chi
// nhanh (HN/HCM/DN) - dung de co du lieu that khi demo RLS (Task 13) va do
// hieu nang truy van (index tren branch_id/customer_id da tao o schema).
//
// Chay: node scripts/seed-data.js   (tu thu muc app/)
//
// Mac dinh seed 2000 khach hang / chi nhanh (tong ~6000), moi khach hang co
// 0-3 don hang ngau nhien, moi don hang ~40% co kem 1 thanh toan. Neu muon
// chay thu nhanh truoc voi it du lieu hon, chinh bien moi truong:
//   SEED_CUSTOMERS_PER_BRANCH=100 node scripts/seed-data.js
//
// LUU Y QUAN TRONG: cot cccd (customers) va so_the (payments) duoc CO Y de
// trong (NULL) o day. Task 13 se ghi de bang pgp_sym_encrypt(...) khi tich
// hop ma hoa cot - seed thang chuoi plaintext vao 2 cot nay la sai muc dich
// (2 cot do dinh nghia la bytea de chua ciphertext, khong phai plaintext).
require('dotenv').config();
const { fakerVI: faker } = require('@faker-js/faker');
const pool = require('../src/db');

const PER_BRANCH = Number(process.env.SEED_CUSTOMERS_PER_BRANCH) || 2000;
const TRANG_THAI = ['pending', 'paid', 'shipped', 'cancelled'];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seedCustomersForBranch(branchId, count) {
  const hoTen = [];
  const email = [];
  const sdt = [];
  const diaChi = [];
  const branch = [];

  for (let i = 0; i < count; i++) {
    hoTen.push(faker.person.fullName());
    email.push(faker.internet.email());
    sdt.push(faker.phone.number('09########'));
    diaChi.push(faker.location.streetAddress());
    branch.push(branchId);
  }

  const result = await pool.query(
    `INSERT INTO customers (ho_ten, email, sdt, dia_chi, branch_id)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])
     RETURNING id`,
    [hoTen, email, sdt, diaChi, branch]
  );
  return result.rows.map((r) => r.id);
}

async function seedOrdersForCustomers(customerIds) {
  const custCol = [];
  const tongTien = [];
  const trangThai = [];

  for (const cid of customerIds) {
    const soDon = randInt(0, 3);
    for (let i = 0; i < soDon; i++) {
      custCol.push(cid);
      tongTien.push(randInt(50000, 20000000));
      trangThai.push(TRANG_THAI[randInt(0, TRANG_THAI.length - 1)]);
    }
  }

  if (custCol.length === 0) return [];

  const result = await pool.query(
    `INSERT INTO orders (customer_id, tong_tien, trang_thai)
     SELECT * FROM UNNEST($1::int[], $2::numeric[], $3::text[])
     RETURNING id`,
    [custCol, tongTien, trangThai]
  );
  return result.rows.map((r) => r.id);
}

async function seedPaymentsForOrders(orderIds) {
  const orderCol = [];
  const tenChuThe = [];
  const expMonth = [];
  const expYear = [];

  for (const oid of orderIds) {
    if (Math.random() > 0.4) continue; // ~40% don hang co kem thanh toan
    orderCol.push(oid);
    tenChuThe.push(faker.person.fullName());
    expMonth.push(randInt(1, 12));
    expYear.push(randInt(2025, 2030));
  }

  if (orderCol.length === 0) return 0;

  await pool.query(
    `INSERT INTO payments (order_id, ten_chu_the, exp_month, exp_year)
     SELECT * FROM UNNEST($1::int[], $2::text[], $3::smallint[], $4::smallint[])`,
    [orderCol, tenChuThe, expMonth, expYear]
  );
  return orderCol.length;
}

async function main() {
  const branchRes = await pool.query('SELECT id, ma_chi_nhanh FROM branches ORDER BY id');
  if (branchRes.rows.length === 0) {
    console.error('Chua co chi nhanh nao trong bang branches. Kiem tra lai db/init/02-schema.sql.');
    process.exit(1);
  }

  let totalCustomers = 0;
  let totalOrders = 0;
  let totalPayments = 0;

  for (const branch of branchRes.rows) {
    console.log(`Dang seed ${PER_BRANCH} khach hang cho chi nhanh ${branch.ma_chi_nhanh}...`);
    const customerIds = await seedCustomersForBranch(branch.id, PER_BRANCH);
    totalCustomers += customerIds.length;

    const orderIds = await seedOrdersForCustomers(customerIds);
    totalOrders += orderIds.length;

    const paymentCount = await seedPaymentsForOrders(orderIds);
    totalPayments += paymentCount;

    console.log(`  -> ${customerIds.length} khach hang, ${orderIds.length} don hang, ${paymentCount} thanh toan.`);
  }

  console.log(`Xong. Tong: ${totalCustomers} khach hang, ${totalOrders} don hang, ${totalPayments} thanh toan (3 chi nhanh).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
