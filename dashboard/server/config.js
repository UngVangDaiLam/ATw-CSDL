import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Gốc của package dashboard/, KHÔNG phải thư mục đang đứng khi gọi lệnh.
// Cùng lý do với analyzer/src/config.js: chạy từ gốc repo mà để dotenv đọc
// .env trong thư mục hiện hành thì sẽ nạp nhầm .env của hạ tầng Docker —
// file đó không có DB_USER nên kết nối lặng lẽ đi bằng role khác.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export default {
  // PHẢI là dashboard_user — role CHỈ có SELECT trên audit.alerts. Xem
  // dashboard/README.md mục 3 và postgres/init/04_grants.sql.
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num(process.env.DB_PORT, 15432),
    database: process.env.DB_NAME || 'secdb',
    user: process.env.DB_USER || 'dashboard_user',
    password: process.env.DB_PASSWORD,
    max: 2,
  },

  pollIntervalMs: Math.max(500, num(process.env.POLL_INTERVAL_MS, 2000)),

  // Số cảnh báo gửi cho trình duyệt lúc mới kết nối.
  initialLimit: 200,

  port: num(process.env.PORT, 4000),
  // Mặc định chỉ nghe trên loopback: dashboard không có đăng nhập, mà nội dung
  // của nó (câu SQL của kẻ tấn công, tên nhân viên bị nghi) không nên lộ ra
  // mạng LAN. Muốn mở cho máy khác xem thì đặt HOST=0.0.0.0 một cách có chủ ý.
  host: process.env.HOST || '127.0.0.1',

  distDir: path.join(ROOT, 'dist'),
};
