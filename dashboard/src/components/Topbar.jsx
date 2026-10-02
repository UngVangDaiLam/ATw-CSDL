import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { formatTime } from '../lib/alerts.js';

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock" title="Giờ Việt Nam (theo log_timezone của server)">{formatTime(now.toISOString())}</span>;
}

export default function Topbar({ page, onMenu, onRefresh, theme, onToggleTheme, sound, onToggleSound, lastPollAt }) {
  const [spinning, setSpinning] = useState(false);
  const refresh = () => {
    onRefresh();
    setSpinning(true);
    setTimeout(() => setSpinning(false), 700);
  };

  return (
    <header className="topbar">
      <button type="button" className="btn-icon menu-btn" onClick={onMenu} aria-label="Mở menu">
        <Icon name="menu" />
      </button>
      <div className="topbar-title">
        <h1>{page.title}</h1>
        <p>{page.sub}</p>
      </div>
      <div className="topbar-actions">
        {lastPollAt && <span className="last-poll">Cập nhật {formatTime(lastPollAt)}</span>}
        <button type="button" className="btn-icon" onClick={onToggleSound} title={sound ? 'Tắt âm báo' : 'Bật âm báo khi có cảnh báo nghiêm trọng'}>
          <Icon name={sound ? 'volume' : 'mute'} />
        </button>
        <button type="button" className="btn-icon" onClick={onToggleTheme} title={theme === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button type="button" className="btn-icon" onClick={refresh} title="Tải lại dữ liệu">
          <Icon name="refresh" className={spinning ? 'spin' : ''} />
        </button>
        <Clock />
      </div>
    </header>
  );
}
