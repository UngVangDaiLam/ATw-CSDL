// Siêu dữ liệu về các rule của analyzer và cách phân mức — một nguồn duy nhất
// cho mọi trang. Mã rule và điểm số khớp với analyzer/src/rules/ và bảng ở
// dashboard/README.md mục 4. `score` là điểm của rule (BULK_DECRYPT thay đổi
// 70–95 theo số bản ghi, lấy mức trần) — dùng để tô màu khi chỉ có mã rule.

export const RULES = {
  SQLI_UNION: {
    score: 90,
    label: 'SQL Injection · UNION',
    hint: 'Câu lệnh có UNION … SELECT — ghép thêm truy vấn để kéo dữ liệu bảng khác',
  },
  BULK_DECRYPT: {
    score: 95,
    label: 'Giải mã hàng loạt',
    hint: 'Một câu lệnh giải mã nhiều CCCD — dấu hiệu rút dữ liệu',
  },
  SQLI_TAUTOLOGY: {
    score: 85,
    label: 'SQL Injection · luôn đúng',
    hint: "Mệnh đề kiểu OR 1=1, OR 'a'='a' để vượt điều kiện lọc",
  },
  STAFF_CREDENTIAL_READ: {
    score: 75,
    label: 'Đọc mật khẩu nhân viên',
    hint: 'Phiên nhân viên đọc app.staff — bảng chứa password_hash',
  },
  ACCESS_DENIED: {
    score: 85,
    label: 'Bị từ chối quyền',
    hint: 'PostgreSQL từ chối câu lệnh (vd. đọc password_hash) — lớp 1 đã chặn, cảnh báo là dấu vết lần thử (65, hoặc 85 nếu nhắm vào thông tin đăng nhập)',
  },
  SQLI_SCHEMA_PROBE: {
    score: 70,
    label: 'Dò cấu trúc CSDL',
    hint: 'Truy vấn information_schema / pg_catalog để do thám',
  },
  FULL_TABLE_READ: {
    score: 60,
    label: 'Đọc toàn bảng nhạy cảm',
    hint: 'SELECT trên bảng nhạy cảm mà không có WHERE',
  },
  // Hai rule duoi den tu TANG WEB (app/src/securityLog.js -> analyzer/src/
  // appEvents.js), khong phai tu log pgAudit.
  LOGIN_BRUTE_FORCE: {
    score: 80,
    label: 'Dò mật khẩu',
    hint: 'Đăng nhập sai liên tiếp tới mức bị khóa tạm — dấu hiệu dò mật khẩu (tầng web)',
  },
  CSRF_BLOCKED: {
    score: 70,
    label: 'CSRF bị chặn',
    hint: 'Request ghi dữ liệu không có CSRF token hợp lệ hoặc gửi dạng form — có thể là trang khác giả mạo request (tầng web)',
  },
  AFTER_HOURS: {
    score: 40,
    label: 'Truy cập ngoài giờ',
    hint: 'Ngoài 7h–19h hoặc cuối tuần — điểm thấp, có giá trị khi đi kèm rule khác',
  },
};

export const RULE_CODES = Object.keys(RULES);

// Tài khoản kết nối chung của ứng dụng. Cảnh báo mang tên này là câu lệnh
// chạy trước khi SET ROLE (chưa quy được về nhân viên nào).
export const SESSION_USER = 'app_user';

// db_user cua canh bao tu tang web: chua xac dinh duoc nhan vien (dang nhap
// chua thanh cong, hoac request CSRF mang cookie cua nan nhan).
export const WEB_ACTOR = 'web';

export function ruleLabel(code) {
  return RULES[code]?.label ?? code;
}

// Phân mức theo README: >= 80 đỏ, 60–79 cam, < 60 vàng.
export const LEVELS = {
  high: { label: 'Nghiêm trọng', range: '≥ 80' },
  medium: { label: 'Cảnh giác', range: '60–79' },
  low: { label: 'Lưu ý', range: '< 60' },
};

export function levelOf(score) {
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

// ─── Thời gian ──────────────────────────────────────────────────────────────
// Server đặt log_timezone = Asia/Ho_Chi_Minh; created_at là timestamptz nên
// quy đổi tường minh về giờ VN thay vì giờ của máy đang mở dashboard.
const fmtTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const fmtDateTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export function formatTime(iso) {
  return iso ? fmtTime.format(new Date(iso)) : '—';
}

export function formatDateTime(iso) {
  return iso ? fmtDateTime.format(new Date(iso)) : '—';
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.round(h / 24)} ngày trước`;
}

// detail.thoi_diem là chuỗi giờ địa phương lấy nguyên từ log, vd.
// "2026-10-02 13:36:33.123 +07". Giữ nguyên giờ, chỉ bỏ phần thừa —
// KHÔNG đưa qua new Date() (xem CLAUDE.md mục analyzer: lệch múi giờ).
export function formatLogTime(s) {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[4]} · ${m[3]}/${m[2]}` : String(s);
}
