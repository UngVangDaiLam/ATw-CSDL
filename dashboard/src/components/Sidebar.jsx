import Icon from './Icon.jsx';

export const PAGES = [
  { id: 'overview', label: 'Tổng quan', icon: 'grid', title: 'Tổng quan', sub: 'Toàn cảnh cảnh báo do analyzer phát hiện từ log pgAudit' },
  { id: 'alerts', label: 'Cảnh báo', icon: 'bell', title: 'Cảnh báo bảo mật', sub: 'Lọc, tìm và xem chi tiết từng cảnh báo trong audit.alerts' },
  { id: 'live', label: 'Theo dõi trực tiếp', icon: 'pulse', title: 'Theo dõi trực tiếp', sub: 'Cảnh báo mới hiện lên ngay khi analyzer ghi vào database' },
  { id: 'config', label: 'Cấu hình pgAudit', icon: 'sliders', title: 'Cấu hình pgAudit', sub: 'Cấu hình đang chạy thật trên server và các lựa chọn mức log' },
];

const CONNECTION = {
  live: { label: 'Đang theo dõi', cls: 'ok' },
  connecting: { label: 'Đang kết nối…', cls: 'wait' },
  'db-down': { label: 'Mất kết nối CSDL', cls: 'bad' },
  offline: { label: 'Mất kết nối server', cls: 'bad' },
};

export default function Sidebar({ page, onNavigate, open, onClose, highCount, connection, status }) {
  const c = CONNECTION[connection];
  return (
    <>
      <div className={`sidebar-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Điều hướng">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="shield" size={20} strokeWidth={2} />
          </div>
          <div>
            <div className="brand-name">SecDB</div>
            <div className="brand-sub">Giám sát bảo mật · Lớp 3</div>
          </div>
        </div>

        <div className="nav">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`nav-item ${page === p.id ? 'active' : ''}`}
              onClick={() => onNavigate(p.id)}
            >
              <Icon name={p.icon} />
              <span>{p.label}</span>
              {p.id === 'alerts' && highCount > 0 && <span className="nav-count">{highCount}</span>}
              {p.id === 'live' && connection === 'live' && <span className="nav-live" />}
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className={`conn conn-${c.cls}`}>
            <span className="conn-dot" />
            <div>
              <div className="conn-label">{c.label}</div>
              <div className="conn-sub">
                {connection === 'live' && `dashboard_user · poll ${Math.round((status.pollIntervalMs ?? 2000) / 100) / 10}s`}
                {connection === 'db-down' && (status.error ?? 'Không truy vấn được audit.alerts')}
                {connection === 'offline' && 'Backend dashboard không phản hồi'}
                {connection === 'connecting' && 'localhost:15432 / secdb'}
              </div>
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
