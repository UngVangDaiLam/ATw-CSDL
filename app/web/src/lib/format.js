// Dinh dang hien thi. Gio luon theo Asia/Ho_Chi_Minh (trung log_timezone cua
// server), khong theo mui gio cua may dang mo trang.

const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? money.format(n) : '—';
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : dateTime.format(d);
}

// Trang thai don hang - khop CHECK constraint o postgres/init/03_schema.sql.
export const ORDER_STATUS = {
  new: { label: 'Mới', cls: 'badge-accent' },
  paid: { label: 'Đã thanh toán', cls: '' },
  shipped: { label: 'Đã giao', cls: '' },
  cancelled: { label: 'Đã hủy', cls: 'badge-warn' },
};

export const BRANCHES = { 1: 'Hà Nội', 2: 'Đà Nẵng', 3: 'Hồ Chí Minh' };

export function branchName(id) {
  return BRANCHES[id] ?? (id == null ? '—' : `#${id}`);
}

// Gia tri tra ve tu API hien thi duoi dang van ban. KHONG render HTML tu du
// lieu - React tu escape text node.
export function text(v) {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
