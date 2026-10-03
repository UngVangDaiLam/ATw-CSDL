const express = require('express');
const pool = require('../db');
const { issueCsrfToken } = require('../csrf');
const limiter = require('../loginLimiter');
const { securityEvent, clip } = require('../securityLog');
const { serverError } = require('../errors');

const router = express.Router();

// POST /auth/login - xac thuc bang username/password (parameterized query -
// KHONG noi chuoi truc tiep, khac voi GET /customers/search o duoi).
//
// Dung pool.query() thang (khong SET ROLE) vi luc nay CHUA biet dang nhap
// thanh cong hay chua.
//
// App KHONG doc password_hash - app_user khong co quyen tren cot do
// (postgres/init/04_grants.sql). So mat khau nam trong database:
// app.verify_staff_login() (05_crypto.sql) dung crypt() cua pgcrypto, dung
// mat khau thi tra 1 dong thong tin nhan vien, sai thi 0 dong. Ham do tu chay
// bcrypt voi salt gia khi username khong ton tai, nen thoi gian phan hoi khong
// lo username nao co that.
//
// Mat khau PHAI di qua tham so $2: noi chuoi vao cau SQL la mat khau nam
// nguyen van trong log pgAudit.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Thieu username/password' });
  }

  // Dang bi khoa vi sai qua nhieu lan: tu choi truoc khi kiem tra mat khau
  // (src/loginLimiter.js).
  const wait = limiter.lockedFor(req.ip, username);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ status: 'error', message: `Sai qua nhieu lan. Thu lai sau ${Math.ceil(wait / 60)} phut.` });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, db_user, branch_id, full_name
       FROM app.verify_staff_login($1, $2)`,
      [String(username), String(password)]
    );

    const staff = result.rows[0];
    if (!staff) {
      const lock = limiter.recordFailure(req.ip, username);
      // Vua bi khoa: ghi MOT su kien cho lop 3 (src/securityLog.js). Khong ghi
      // mat khau; username la du lieu nguoi dung go vao - cat ngan.
      if (lock.justLocked) {
        securityEvent('login_locked', req, {
          username: clip(username),
          lock_scope: lock.justLocked,
          failures: lock.failures,
          retry_after_s: lock.retryAfter,
        });
      }
      return res.status(401).json({ status: 'error', message: 'Sai username hoac password' });
    }
    limiter.recordSuccess(req.ip, username);

    // Cap MA PHIEN MOI ngay khi dang nhap thanh cong (chong session fixation):
    // neu ai do da cai san cho nan nhan mot ma phien ho biet truoc, ma do bi
    // bo di o day thay vi duoc "nang cap" thanh phien da dang nhap.
    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ status: 'error', message: 'Khong tao duoc phien' });
      }
      // db_user (vd 'nv_hn01') la thu duy nhat middleware/setRole.js can - day
      // chinh la cau noi giua "nhan vien nao dang nhap" va "role PostgreSQL
      // nao se SET LOCAL ROLE sang cho request tiep theo".
      req.session.staff = {
        id: staff.id,
        username: staff.username,
        db_user: staff.db_user,
        branch_id: staff.branch_id,
        full_name: staff.full_name,
      };
      // Phien moi thi token moi - token cu thuoc phien vua bi bo.
      res.json({ status: 'ok', staff: req.session.staff, csrfToken: issueCsrfToken(req) });
    });
  } catch (err) {
    serverError(res, err, 'POST /auth/login');
  }
});

// GET /auth/csrf - lay CSRF token cho phien hien tai (tao phien neu chua co).
// Phai goi truoc POST /auth/login va moi request ghi du lieu - xem src/csrf.js.
router.get('/csrf', (req, res) => {
  res.json({ status: 'ok', csrfToken: issueCsrfToken(req) });
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
    // Xoa phien phia server la chinh; xoa ca cookie de trinh duyet khong giu
    // ma phien cu (cung ten, cung thuoc tinh voi luc tao).
    res.clearCookie('secdb.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true' });
    res.json({ status: 'ok' });
  });
});

module.exports = router;
