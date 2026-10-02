import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import { login } from '../api.js';

// Tai khoan demo cua postgres/init/07_seed.sql - dien nhanh cho buoi trinh bay.
const DEMO = [
  { username: 'hn01', branch: 'Hà Nội' },
  { username: 'dn01', branch: 'Đà Nẵng' },
  { username: 'hcm01', branch: 'Hồ Chí Minh' },
];
const DEMO_PASSWORD = 'Demo@123456';

export default function Login({ onLogin, theme, onToggleTheme }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await login(username.trim(), password);
      onLogin(res.staff);
    } catch (err) {
      if (err.status === 429) {
        const min = Math.ceil((err.retryAfter || 900) / 60);
        setError(`Sai quá nhiều lần. Tài khoản này tạm khóa, thử lại sau khoảng ${min} phút.`);
      } else if (err.status === 401) {
        setError('Sai tên đăng nhập hoặc mật khẩu.');
      } else {
        setError(err.message || 'Không kết nối được máy chủ.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <button type="button" className="icon-btn login-theme" onClick={onToggleTheme} title="Đổi chế độ sáng/tối">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <span className="brand-mark lg"><Icon name="shield" size={24} strokeWidth={2} /></span>
          <h1>Đăng nhập</h1>
          <p>Hệ thống quản lý khách hàng theo chi nhánh</p>
        </div>

        <label className="field">
          <span>Tên đăng nhập</span>
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Mật khẩu</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>

        {error && (
          <div className="alert alert-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>

        <div className="demo">
          <span className="demo-label">Tài khoản demo (mật khẩu <code>{DEMO_PASSWORD}</code>)</span>
          <div className="demo-list">
            {DEMO.map((d) => (
              <button
                key={d.username}
                type="button"
                className="chip"
                onClick={() => {
                  setUsername(d.username);
                  setPassword(DEMO_PASSWORD);
                }}
              >
                <strong>{d.username}</strong> {d.branch}
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
}
