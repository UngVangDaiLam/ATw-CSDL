const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');
const { loadSessionSecret } = require('./sessionSecret');
const { serverError, notFound, errorHandler } = require('./errors');

let sessionSecret;
try {
  sessionSecret = loadSessionSecret();
} catch (err) {
  console.error(`[app] KHONG KHOI DONG: ${err.message}`);
  process.exit(1);
}

const { securityHeaders, noStore } = require('./httpHeaders');

const app = express();
// Khong quang cao "X-Powered-By: Express" cho ai do phien ban.
app.disable('x-powered-by');
app.use(securityHeaders);
// Body JSON toi da 10 KB - du cho moi form cua app, chan request phinh to.
app.use(express.json({ limit: '10kb' }));

// Session luu trong memory - du dung cho demo. Khong dung trong production
// (mat session khi restart, khong scale duoc nhieu instance).
app.use(
  session({
    // Ten rieng thay cho "connect.sid" mac dinh (lo ra dung express-session).
    name: 'secdb.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    // Moi request gia han them 30 phut; ngoi im qua 30 phut thi het phien.
    rolling: true,
    cookie: {
      httpOnly: true,       // JavaScript tren trang khong doc duoc cookie (XSS khong lay duoc phien)
      sameSite: 'strict',   // trinh duyet khong gui cookie theo request tu trang khac (CSRF)
      // Chi gui qua HTTPS. Lab chay http://127.0.0.1 nen mac dinh tat; dat
      // COOKIE_SECURE=true khi co HTTPS that phia truoc.
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 1000 * 60 * 30,
    },
  })
);

// Endpoint kiem tra: ket noi DB co song khong, va dang dung dung user nao.
// current_user phai la "app_user", KHONG duoc la "postgres" hay "db_owner".
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT current_user, current_database(), now() AS server_time'
    );
    res.json({ status: 'ok', ...result.rows[0] });
  } catch (err) {
    serverError(res, err, 'GET /health');
  }
});

// Moi request ghi du lieu: phai la JSON va mang CSRF token dung (src/csrf.js).
const { requireJson, verifyCsrf } = require('./csrf');
app.use(requireJson);
app.use(verifyCsrf);

app.use('/auth', noStore, authRoutes);
app.use('/customers', noStore, customerRoutes);
app.use('/orders', noStore, orderRoutes);

// Giao dien web (web/ -> npm run build -> public/). Phuc vu CUNG origin voi
// API: dieu kien de cookie SameSite=Strict va CSRF token hoat dong ma khong can
// bat CORS. Dat SAU cac route API nen khong che duoc duong dan API nao.
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir));
} else {
  app.get('/', (req, res) =>
    res.type('text').send('Chua build giao dien. Chay: npm run build (hoac docker compose up -d --build app)')
  );
}

// Phai dat CUOI CUNG: route khong ton tai, roi moi loi chua ai bat (ke ca JSON
// hong tu express.json) - khong de Express tra trang loi mac dinh kem stack
// trace. Xem src/errors.js.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
