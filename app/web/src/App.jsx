import { useCallback, useEffect, useState } from 'react';
import Icon from './components/Icon.jsx';
import Login from './pages/Login.jsx';
import Customers from './pages/Customers.jsx';
import Orders from './pages/Orders.jsx';
import { currentStaff, logout } from './api.js';
import { branchName } from './lib/format.js';

// Dieu huong bang hash (#/customers): API cua app nam o /customers, /orders -
// dung duong dan that cho trang se dung voi API.
const PAGES = [
  { id: 'customers', label: 'Khách hàng', icon: 'user' },
  { id: 'orders', label: 'Đơn hàng', icon: 'archive' },
];

function pageFromHash() {
  const id = window.location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === id) ? id : 'customers';
}

function stored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [staff, setStaff] = useState(undefined);   // undefined = dang kiem tra phien
  const [page, setPage] = useState(pageFromHash);
  const [theme, setTheme] = useState(() =>
    stored('secdb.app.theme', null) ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );

  useEffect(() => {
    currentStaff().then(setStaff).catch(() => setStaff(null));
  }, []);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('secdb.app.theme', next);
    } catch {
      /* khong luu duoc cung khong sao */
    }
  };

  // Phien het han giua chung (30 phut khong hoat dong): API tra 401 -> ve trang dang nhap.
  const onUnauthorized = useCallback(() => setStaff(null), []);

  const signOut = async () => {
    await logout().catch(() => {});
    setStaff(null);
  };

  if (staff === undefined) {
    return <div className="boot"><div className="spinner" /></div>;
  }
  if (!staff) {
    return <Login onLogin={setStaff} theme={theme} onToggleTheme={toggleTheme} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="shield" size={18} strokeWidth={2} /></span>
          <span className="brand-name">SecDB</span>
        </div>
        <nav className="tabs" aria-label="Điều hướng">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={`tab ${page === p.id ? 'active' : ''}`}>
              <Icon name={p.icon} size={16} />
              {p.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <div className="who-text">
            <span className="who-name">{staff.full_name || staff.username}</span>
            <span className="who-meta">
              Chi nhánh {branchName(staff.branch_id)} · <code>{staff.db_user}</code>
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button type="button" className="btn btn-ghost" onClick={signOut}>Đăng xuất</button>
        </div>
      </header>

      <main className="main">
        {page === 'customers' && <Customers staff={staff} onUnauthorized={onUnauthorized} />}
        {page === 'orders' && <Orders staff={staff} onUnauthorized={onUnauthorized} />}
      </main>
    </div>
  );
}
