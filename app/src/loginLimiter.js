// Gioi han so lan dang nhap SAI.
//
// Hai nguong, cung cua so 15 phut:
//   - theo cap (IP, username): 5 lan sai -> khoa tam cap do toi het cua so.
//     Dang nhap dung xoa so lan sai cua cap do.
//   - theo rieng IP: 100 lan sai -> khoa moi dang nhap tu IP do. Chan viec thu
//     lan luot rat nhieu username tu mot cho.
//
// Chi dem lan SAI: nguoi dung dang nhap dung bao nhieu lan cung khong bi khoa.
// Khi dang bi khoa, tu choi NGAY ca khi mat khau dung - neu khong, ke do van
// biet duoc mat khau nao dung qua phan hoi khac nhau.
//
// Bo dem nam trong bo nho tien trinh: khoi dong lai app la mat. Du cho lab mot
// instance; chay nhieu instance thi phai dung kho chung (vd. Redis).

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 100;

const counters = new Map();   // key -> { count, resetAt }

function current(key, now) {
  const entry = counters.get(key);
  if (!entry || entry.resetAt <= now) return null;
  return entry;
}

function keysFor(ip, username) {
  return {
    user: `u:${ip}|${String(username || '').trim().toLowerCase()}`,
    ip: `i:${ip}`,
  };
}

// So giay con lai neu dang bi khoa, 0 neu khong.
function lockedFor(ip, username, now = Date.now()) {
  const k = keysFor(ip, username);
  const checks = [[k.user, MAX_PER_USER], [k.ip, MAX_PER_IP]];
  let wait = 0;
  for (const [key, max] of checks) {
    const entry = current(key, now);
    if (entry && entry.count >= max) wait = Math.max(wait, Math.ceil((entry.resetAt - now) / 1000));
  }
  return wait;
}

function recordFailure(ip, username, now = Date.now()) {
  const k = keysFor(ip, username);
  const counts = {};
  for (const [name, key] of [['user', k.user], ['ip', k.ip]]) {
    const entry = current(key, now) || { count: 0, resetAt: now + WINDOW_MS };
    entry.count += 1;
    counters.set(key, entry);
    counts[name] = entry;
  }
  // Bao lai DUNG LUC vua cham nguong (chuyen tu "mo" sang "khoa") de nguoi goi
  // ghi MOT su kien cho moi lan khoa, khong ghi lap lai moi lan bi tu choi.
  let justLocked = null;
  if (counts.ip.count === MAX_PER_IP) justLocked = 'ip';
  else if (counts.user.count === MAX_PER_USER) justLocked = 'user';
  return {
    justLocked,
    failures: justLocked === 'ip' ? counts.ip.count : counts.user.count,
    retryAfter: Math.ceil(((justLocked === 'ip' ? counts.ip : counts.user).resetAt - now) / 1000),
  };
}

function recordSuccess(ip, username) {
  counters.delete(keysFor(ip, username).user);
}

// Don cac muc da het han, de bo dem khong phinh mai.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of counters) if (entry.resetAt <= now) counters.delete(key);
}, 60 * 1000);
sweeper.unref();

module.exports = { lockedFor, recordFailure, recordSuccess, MAX_PER_USER, WINDOW_MS };
