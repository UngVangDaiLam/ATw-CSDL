// Header bao mat cho moi phan hoi cua app/.
//
// Viet tay thay vi them thu vien: moi dong co ly do ghi ngay ben canh, doc
// duoc khi trinh bay. Cac header nay khong sua duoc loi trong code (2 lo hong
// co y van con nguyen) - chung han che thiet hai khi trinh duyet render noi
// dung, va lam kho cac kieu tan cong dua vao trinh duyet.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",                         // khong script inline / tu domain la
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",                        // trang chi goi duoc API cua chinh no
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",                    // khong cho trang khac nhung vao iframe
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  // Khong cho trinh duyet doan kieu noi dung (vd. coi JSON la HTML).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Ban cu cua frame-ancestors, cho trinh duyet khong hieu CSP.
  res.setHeader('X-Frame-Options', 'DENY');
  // Khong lo duong dan (co the chua ?name=...) sang trang khac qua Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

// Phan hoi API co du lieu khach hang (ho ten, so dien thoai, CCCD da giai
// ma): khong de trinh duyet hay proxy luu lai ban sao.
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = { securityHeaders, noStore };
