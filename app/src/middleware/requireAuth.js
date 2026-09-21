// Chan request neu chua dang nhap. req.session.staff duoc set boi
// routes/auth.js sau khi login thanh cong (xem POST /auth/login).
function requireAuth(req, res, next) {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ status: 'error', message: 'Chua dang nhap' });
  }
  next();
}

module.exports = requireAuth;
