import Icon from './Icon.jsx';
import { RiskBadge } from './common.jsx';
import { ruleLabel } from '../lib/alerts.js';

export default function Toasts({ toasts, onOpen, onDismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.key} className={`toast toast-${t.level}`}>
          <button type="button" className="toast-main" onClick={() => onOpen(t.alert)}>
            <RiskBadge score={t.alert.risk_score} size="sm" />
            <div className="toast-text">
              <strong>{t.extra > 0 ? `${t.extra + 1} cảnh báo mới` : ruleLabel(t.alert.rule_triggered)}</strong>
              <span>
                {t.extra > 0 ? `cao nhất: ${ruleLabel(t.alert.rule_triggered)} · ${t.alert.db_user}` : `${t.alert.db_user} · bấm để xem chi tiết`}
              </span>
            </div>
          </button>
          <button type="button" className="toast-close" onClick={() => onDismiss(t.key)} aria-label="Đóng">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
