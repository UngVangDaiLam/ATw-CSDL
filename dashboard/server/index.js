// Backend của dashboard: poll audit.alerts theo id rồi đẩy xuống trình duyệt.
//
// Vì sao POLL mà không LISTEN/NOTIFY: LISTEN không cần quyền gì, nên nếu có
// trigger NOTIFY mỗi khi có cảnh báo thì kẻ chiếm được app_user chỉ cần
// LISTEN là biết mình vừa bị phát hiện. Xem dashboard/README.md mục 5.

import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import config from './config.js';
import { pool, latestAlerts, alertsAfter, stats, auditSettings, inRecovery } from './alerts.js';

const app = express();
const server = http.createServer(app);
// Không bật CORS: giao diện luôn cùng origin (dev thì qua proxy của Vite).
const io = new Server(server);

// Dashboard hiển thị nguyên văn câu SQL do kẻ tấn công viết. React đã render
// bằng text node, CSP là lớp thứ hai: kể cả có chỗ nào lỡ chèn HTML thì script
// inline vẫn không chạy.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ─── Trạng thái dùng chung ──────────────────────────────────────────────────
const state = {
  lastId: null,          // id lớn nhất đã đẩy xuống client; null = chưa khởi tạo
  status: { db: 'connecting', error: null, lastPollAt: null, pollIntervalMs: config.pollIntervalMs },
  stats: null,
  settings: null,
};

function setStatus(patch) {
  const prev = state.status.db;
  state.status = { ...state.status, ...patch };
  if (patch.db && patch.db !== prev) console.log(`[db] ${prev} -> ${patch.db}${patch.error ? ` (${patch.error})` : ''}`);
  io.emit('status', state.status);
}

async function refreshStats() {
  state.stats = await stats();
  io.emit('stats', state.stats);
  return state.stats;
}

// Khởi tạo (hoặc khởi tạo lại sau khi mất kết nối / reset DB).
async function init() {
  // Chua doc gi khi database con dang khoi phuc - xem inRecovery() o alerts.js.
  // Nem loi de giu trang thai 'down'; nhip sau thu lai.
  if (await inRecovery()) throw new Error('database dang khoi phuc (PITR) - cho xong moi doc');
  const s = await refreshStats();
  // Khởi tạo LẠI sau khi mất kết nối: không biết lúc mất kết nối đã xảy ra gì -
  // reset.sh làm lại cả bảng, PITR quay lui một phần (cảnh báo sau mốc khôi
  // phục biến mất, id đánh lại), analyzer ghi bù... So max_id với con trỏ cũ
  // KHÔNG đủ: ghi bù đủ nhiều thì max_id vượt con trỏ cũ dù bảng đã đổi. Nên
  // luôn bắt client tải lại toàn bộ và đặt con trỏ theo hiện tại.
  // Phát cả ở lần khởi tạo ĐẦU: client nào kết nối lúc DB chưa sẵn sàng (vd.
  // ngay sau reset.sh) chưa nhận được snapshot, phải được báo để xin lại.
  if (state.lastId !== null) {
    console.log(`[poll] ket noi lai (max_id ${s.max_id}, con tro cu ${state.lastId}) - yeu cau client tai lai`);
  }
  state.lastId = s.max_id;
  io.emit('reset');
  state.settings = await auditSettings().catch(() => null);
}

let tick = 0;
async function poll() {
  try {
    if (state.lastId === null || state.status.db !== 'up') await init();

    const rows = await alertsAfter(state.lastId);
    if (rows.length) {
      state.lastId = rows[rows.length - 1].id;
      io.emit('alerts', rows);
      await refreshStats();
    } else if (++tick % 15 === 0) {
      // Thỉnh thoảng (≈30 s) làm mới thống kê dù không có gì mới: dải 24 giờ
      // trên biểu đồ phải trôi theo đồng hồ, và cũng là lúc phát hiện bảng bị
      // làm lại trong khi kết nối không hề đứt.
      const prevLast = state.lastId;
      const s = await refreshStats();
      if (s.max_id < prevLast) {
        state.lastId = s.max_id;
        io.emit('reset');
      }
    }
    setStatus({ db: 'up', error: null, lastPollAt: new Date().toISOString() });
  } catch (err) {
    setStatus({ db: 'down', error: err.message });
  } finally {
    // setTimeout nối tiếp chứ không setInterval: một lần poll chậm (DB đang
    // khởi động lại) không được chồng lên lần sau.
    setTimeout(poll, config.pollIntervalMs);
  }
}

async function snapshot() {
  // Đang mất kết nối hoặc DB đang khôi phục: không đưa dữ liệu dở dang cho
  // client. Khi poll khởi tạo lại được, nó phát 'reset' và client xin lại.
  if (state.status.db !== 'up') throw new Error(state.status.error || 'database chua san sang');
  return {
    alerts: await latestAlerts(config.initialLimit),
    stats: state.stats ?? (await refreshStats()),
    settings: state.settings ?? (await auditSettings().catch(() => null)),
    status: state.status,
  };
}

io.on('connection', async (socket) => {
  const send = async () => {
    try {
      socket.emit('snapshot', await snapshot());
    } catch (err) {
      socket.emit('status', { ...state.status, db: 'down', error: err.message });
    }
  };
  await send();
  socket.on('refresh', send);
});

app.get('/api/health', (req, res) => {
  res.status(state.status.db === 'up' ? 200 : 503).json(state.status);
});

// Bản build của giao diện (npm run build). Lúc dev thì Vite phục vụ.
if (fs.existsSync(config.distDir)) {
  app.use(express.static(config.distDir));
  app.get('*', (req, res) => res.sendFile('index.html', { root: config.distDir }));
} else {
  app.get('/', (req, res) =>
    res.type('text').send('Chua co ban build. Chay "npm run build", hoac "npm run dev" roi mo http://127.0.0.1:5173')
  );
}

if (!config.db.password) {
  console.error('Thieu DB_PASSWORD. Sao chep dashboard/.env.example thanh dashboard/.env va dien DASHBOARD_PASSWORD.');
  process.exit(1);
}
if (config.db.user !== 'dashboard_user') {
  console.warn(`[canh bao] DB_USER = ${config.db.user}. Dashboard duoc thiet ke cho dashboard_user (chi SELECT audit.alerts).`);
}

server.listen(config.port, config.host, () => {
  console.log(`Dashboard backend: http://${config.host}:${config.port}  (poll ${config.pollIntervalMs} ms, role ${config.db.user})`);
  poll();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    io.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
