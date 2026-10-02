import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar, { PAGES } from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Toasts from './components/Toasts.jsx';
import AlertDrawer from './components/AlertDrawer.jsx';
import Overview from './pages/Overview.jsx';
import Alerts, { EMPTY_FILTER } from './pages/Alerts.jsx';
import Live from './pages/Live.jsx';
import AuditConfig from './pages/AuditConfig.jsx';
import { useAlerts } from './hooks/useAlerts.js';
import { levelOf } from './lib/alerts.js';

// localStorage có thể ném lỗi (chế độ riêng tư, trình duyệt chặn) — chỉ là
// tiện ích ghi nhớ lựa chọn, hỏng thì dùng mặc định.
function stored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* bỏ qua */
  }
}

function pageFromHash() {
  const id = window.location.hash.replace('#', '');
  return PAGES.some((p) => p.id === id) ? id : 'overview';
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.32);
    o.onended = () => ctx.close();
  } catch {
    /* không có âm thanh cũng không sao */
  }
}

let seq = 0;
const nextKey = () => ++seq;

export default function App() {
  const [page, setPage] = useState(pageFromHash);
  const [menuOpen, setMenuOpen] = useState(false);
  // Chưa chọn lần nào thì theo hệ điều hành; bấm đổi rồi mới ghi nhớ.
  const [theme, setTheme] = useState(() =>
    stored('secdb.theme', null) ?? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  );
  const [sound, setSound] = useState(() => stored('secdb.sound', 'off') === 'on');
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [selected, setSelected] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [newIds, setNewIds] = useState(() => new Set());
  const [events, setEvents] = useState([]);
  const [watchingSince] = useState(() => new Date().toISOString());
  const [now, setNow] = useState(() => Date.now());
  const [unseen, setUnseen] = useState(0);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const pushEvent = useCallback((e) => {
    setEvents((cur) => [...cur, { key: nextKey(), at: new Date().toISOString(), ...e }].slice(-300));
  }, []);

  const dismissToast = useCallback((key) => setToasts((t) => t.filter((x) => x.key !== key)), []);

  const onNewAlerts = useCallback((fresh) => {
    fresh.forEach((alert) => pushEvent({ alert }));

    const ids = fresh.map((a) => a.id);
    setNewIds((s) => new Set([...s, ...ids]));
    setTimeout(() => setNewIds((s) => {
      const n = new Set(s);
      ids.forEach((id) => n.delete(id));
      return n;
    }), 5000);

    // Một lượt analyzer có thể ghi cả chục cảnh báo: gộp thành MỘT thông báo,
    // hiện cảnh báo nặng nhất, thay vì phủ kín màn hình.
    const top = fresh.reduce((m, a) => (a.risk_score > m.risk_score ? a : m), fresh[0]);
    const key = nextKey();
    setToasts((t) => [...t.slice(-2), { key, alert: top, extra: fresh.length - 1, level: levelOf(top.risk_score) }]);
    setTimeout(() => dismissToast(key), 7000);

    if (soundRef.current && top.risk_score >= 80) beep();
    if (document.hidden) setUnseen((n) => n + fresh.length);
  }, [pushEvent, dismissToast]);

  const { alerts, stats, settings, status, connection, loaded, refresh } = useAlerts({ onNewAlerts });

  // ─── Hiệu ứng phụ ─────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => store('secdb.sound', sound ? 'on' : 'off'), [sound]);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onVis = () => !document.hidden && setUnseen(0);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    document.title = unseen > 0 ? `(${unseen}) SecDB · Giám sát` : 'SecDB · Giám sát';
  }, [unseen]);

  // Ghi lại các lần đổi trạng thái kết nối vào luồng sự kiện.
  const prevConn = useRef(null);
  const everLive = useRef(false);
  useEffect(() => {
    if (prevConn.current === connection) return;
    prevConn.current = connection;
    if (connection === 'live') {
      pushEvent({ kind: 'ok', text: everLive.current ? 'Kết nối lại thành công, tiếp tục theo dõi audit.alerts' : 'Đã kết nối, bắt đầu theo dõi audit.alerts' });
      everLive.current = true;
    }
    if (connection === 'db-down') pushEvent({ kind: 'error', text: `Mất kết nối database: ${status.error ?? 'không rõ lỗi'}` });
    if (connection === 'offline' && everLive.current) pushEvent({ kind: 'error', text: 'Mất kết nối tới backend dashboard, đang thử lại…' });
  }, [connection, status.error, pushEvent]);

  // ─── Điều hướng ───────────────────────────────────────────────────────────
  const navigate = useCallback((id) => {
    window.location.hash = id;
    setPage(id);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  const filterBy = (patch) => {
    setFilter({ ...EMPTY_FILTER, ...patch });
    navigate('alerts');
  };

  const current = PAGES.find((p) => p.id === page);

  return (
    <div className="app">
      <Sidebar
        page={page}
        onNavigate={navigate}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        highCount={stats?.high ?? 0}
        connection={connection}
        status={status}
      />
      <main className="main">
        <Topbar
          page={current}
          onMenu={() => setMenuOpen(true)}
          onRefresh={refresh}
          theme={theme}
          onToggleTheme={() => setTheme((t) => {
            const next = t === 'dark' ? 'light' : 'dark';
            store('secdb.theme', next);
            return next;
          })}
          sound={sound}
          onToggleSound={() => setSound((s) => !s)}
          lastPollAt={connection === 'live' ? status.lastPollAt : null}
        />

        {connection !== 'live' && loaded && (
          <div className={`banner banner-${connection === 'connecting' ? 'wait' : 'bad'}`}>
            {connection === 'db-down' && <>Không truy vấn được <code>audit.alerts</code>: {status.error}. Dữ liệu đang hiển thị có thể đã cũ.</>}
            {connection === 'offline' && <>Mất kết nối tới backend dashboard. Đang thử kết nối lại…</>}
            {connection === 'connecting' && <>Đang kết nối database…</>}
          </div>
        )}

        <div className="content">
          {!loaded ? (
            <div className="page">
              <div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div>
              <div className="skeleton" style={{ height: 260 }} />
              {connection === 'db-down' && <p className="muted center">Không kết nối được database: {status.error}</p>}
            </div>
          ) : (
            <>
              {page === 'overview' && (
                <Overview
                  stats={stats}
                  alerts={alerts}
                  now={now}
                  onOpen={setSelected}
                  onNavigate={navigate}
                  onFilterRule={(rule) => filterBy({ rule })}
                  onFilterUser={(user) => filterBy({ user })}
                />
              )}
              {page === 'alerts' && (
                <Alerts alerts={alerts} stats={stats} filter={filter} setFilter={setFilter} onOpen={setSelected} newIds={newIds} now={now} />
              )}
              {page === 'live' && (
                <Live events={events} watchingSince={watchingSince} onOpen={setSelected} onClear={() => setEvents([])} />
              )}
              {page === 'config' && <AuditConfig settings={settings} />}
            </>
          )}
        </div>
      </main>

      <AlertDrawer alert={selected} onClose={() => setSelected(null)} />
      <Toasts
        toasts={toasts}
        onDismiss={dismissToast}
        onOpen={(a) => {
          setSelected(a);
        }}
      />
    </div>
  );
}
