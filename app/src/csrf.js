// Chong CSRF cho app/.
//
// Cookie phien da SameSite=Strict (app.js) - trinh duyet hien dai khong gui no
// theo request xuat phat tu trang khac. Hai lop duoi day la phong thu thu hai,
// cho trinh duyet cu va cho truong hop SameSite bi noi long ve sau:
//
// 1. Synchronizer token. Token ngau nhien song trong phien (phia server).
//    Client lay qua GET /auth/csrf, gui lai o header X-CSRF-Token voi moi
//    request ghi du lieu. Trang la khong doc duoc token (same-origin policy)
//    nen khong gia mao duoc request hop le.
//
// 2. Bat buoc Content-Type: application/json cho request ghi. Form HTML - cach
//    CSRF co dien - chi gui duoc urlencoded, multipart hoac text/plain; muon
//    gui JSON tu trang khac thi trinh duyet phai hoi CORS preflight truoc, ma
//    app khong bat CORS.
//
// Ap dung CA cho /auth/login: chong "login CSRF" (trang la dang nhap nan nhan
// vao tai khoan cua ke tan cong, roi doc duoc nhung gi nan nhan nhap vao).

const crypto = require('crypto');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function issueCsrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

// So sanh hang thoi gian: khong de lo token qua do tre phan hoi.
function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireJson(req, res, next) {
  if (UNSAFE.has(req.method) && !req.is('application/json')) {
    return res.status(415).json({ status: 'error', message: 'Chi nhan Content-Type: application/json' });
  }
  next();
}

function verifyCsrf(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();
  const expected = req.session && req.session.csrf;
  const got = req.get('X-CSRF-Token');
  if (!expected || !got || !sameToken(expected, got)) {
    return res.status(403).json({ status: 'error', message: 'Thieu hoac sai CSRF token - lay token qua GET /auth/csrf' });
  }
  next();
}

module.exports = { issueCsrfToken, requireJson, verifyCsrf };
