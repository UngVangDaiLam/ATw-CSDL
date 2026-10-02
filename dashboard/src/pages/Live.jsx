import { useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Card, CopyButton, RiskBadge } from '../components/common.jsx';
import { formatTime, levelOf, ruleLabel } from '../lib/alerts.js';

// Trang này KHÔNG tự chạy analyzer. Dashboard chỉ có quyền đọc audit.alerts;
// việc phân tích log và ghi cảnh báo là của analyzer_user (chỉ INSERT). Không
// tiến trình nào vừa đọc vừa ghi được cảnh báo — xem CLAUDE.md mục "Schema".
const STEPS = [
  { cmd: 'docker compose logs -f analyzer', text: 'Analyzer đã chạy liên tục trong Docker: mọi hành vi trên app tự hiện ở đây sau 1–4 giây. Lệnh này để xem nó làm việc.' },
  { cmd: 'bash scripts/demo-attack.sh', text: 'Kịch bản tấn công qua app: SQL Injection, IDOR — xem lớp nào chặn, lớp nào ghi nhận.' },
  { cmd: 'bash scripts/gen-alerts.sh', text: 'Diễn lại 5 hành vi xấu trực tiếp trên database (giải mã hàng loạt, dò cấu trúc…).' },
];

export default function Live({ events, watchingSince, onOpen, onClear }) {
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(null);
  const boxRef = useRef(null);
  const shown = paused ? frozen : events;

  useEffect(() => {
    if (!paused && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [events, paused]);

  const togglePause = () => {
    setFrozen(paused ? null : events);
    setPaused(!paused);
  };

  const alertsSeen = events.filter((e) => e.alert);
  const highSeen = alertsSeen.filter((e) => e.alert.risk_score >= 80).length;
  const pending = paused ? events.length - frozen.length : 0;

  return (
    <div className="page">
      <div className="live-stats">
        <div className="mini"><span>Bắt đầu theo dõi</span><strong>{formatTime(watchingSince)}</strong></div>
        <div className="mini"><span>Cảnh báo nhận được</span><strong>{alertsSeen.length}</strong></div>
        <div className="mini mini-high"><span>Nghiêm trọng</span><strong>{highSeen}</strong></div>
      </div>

      <Card
        title="Luồng sự kiện"
        subtitle="Chỉ những gì đến từ lúc mở trang này — lịch sử đầy đủ ở mục Cảnh báo"
        actions={
          <>
            <button type="button" className={`btn btn-sm ${paused ? 'btn-primary' : 'btn-ghost'}`} onClick={togglePause}>
              <Icon name={paused ? 'play' : 'pause'} size={14} />
              {paused ? `Tiếp tục${pending > 0 ? ` (+${pending})` : ''}` : 'Tạm dừng'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} title="Xóa màn hình">
              <Icon name="trash" size={14} />
            </button>
          </>
        }
        bodyClass="flush"
      >
        <div className="console" ref={boxRef}>
          {shown.length === 0 && (
            <div className="console-line cl-muted">
              <span className="cl-time">--:--:--</span>
              <span>Đang chờ cảnh báo mới… chạy một lệnh ở khung bên dưới để thấy chúng xuất hiện.</span>
            </div>
          )}
          {shown.map((e) =>
            e.alert ? (
              <button key={e.key} type="button" className={`console-line cl-alert cl-${levelOf(e.alert.risk_score)}`} onClick={() => onOpen(e.alert)}>
                <span className="cl-time">{formatTime(e.at)}</span>
                <RiskBadge score={e.alert.risk_score} size="sm" />
                <span className="cl-rule">{ruleLabel(e.alert.rule_triggered)}</span>
                <span className="cl-user">{e.alert.db_user}</span>
                <span className="cl-desc">{e.alert.detail?.mo_ta ? String(e.alert.detail.mo_ta) : ''}</span>
              </button>
            ) : (
              <div key={e.key} className={`console-line cl-${e.kind}`}>
                <span className="cl-time">{formatTime(e.at)}</span>
                <span>{e.text}</span>
              </div>
            )
          )}
        </div>
      </Card>

      <Card title="Tạo cảnh báo để xem" subtitle="Chạy ở gốc repo, trong Git Bash">
        <div className="steps">
          {STEPS.map((s, i) => (
            <div key={s.cmd} className="step">
              <span className="step-n">{i + 1}</span>
              <div className="step-main">
                <div className="cmd">
                  <Icon name="terminal" size={14} />
                  <code>{s.cmd}</code>
                  <CopyButton text={s.cmd} label="" />
                </div>
                <p>{s.text}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="note">
          <Icon name="lock" size={14} />
          <span>
          Dashboard không có nút "chạy phân tích": nó kết nối bằng <code>dashboard_user</code>, chỉ <code>SELECT</code> được <code>audit.alerts</code>.
          Cảnh báo chỉ có thể do analyzer (<code>analyzer_user</code>, chỉ <code>INSERT</code>) ghi vào.
          </span>
        </p>
      </Card>
    </div>
  );
}
