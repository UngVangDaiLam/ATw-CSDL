// Xu ly loi: KHONG gui chi tiet noi bo cho client.
//
// Truoc day cac route tra nguyen err.message cua PostgreSQL ("duplicate key
// value violates unique constraint customers_cccd_hash_key", "violates foreign
// key constraint orders_customer_id_fkey"...) - lo ten bang, ten cot, ten rang
// buoc, giup ke tan cong ve duoc so do CSDL. Con JSON hong thi Express tra trang
// loi mac dinh kem NGUYEN STACK TRACE (duong dan /app/node_modules/..., phien
// ban thu vien).
//
// Gio client chi nhan thong bao chung kem MA THAM CHIEU; chi tiet day du ghi
// vao log server cung ma do (`docker compose logs app`) de tra cuu.
//
// HAI ENDPOINT CO Y (GET /customers/search, GET /orders/:id) KHONG dung file
// nay - giu nguyen cach viet ban dau, xem app/README.md "Lo hong co y".

const crypto = require('crypto');

function serverError(res, err, where) {
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[loi ${ref}] ${where}: ${err && (err.stack || err.message)}`);
  return res.status(500).json({ status: 'error', message: `Loi may chu. Ma tham chieu: ${ref}`, ref });
}

// Route khong ton tai: JSON ngan gon thay cho trang "Cannot GET ..." cua Express.
function notFound(req, res) {
  res.status(404).json({ status: 'error', message: 'Khong tim thay' });
}

// Middleware loi cuoi cung (4 tham so). Bat ca loi tu express.json() - chay
// truoc moi route nen try/catch trong route khong bat duoc.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 'error', message: 'Body khong phai JSON hop le' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ status: 'error', message: 'Body qua lon (toi da 10 KB)' });
  }
  return serverError(res, err, `${req.method} ${req.path}`);
}

module.exports = { serverError, notFound, errorHandler };
