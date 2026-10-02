import { useState } from 'react';
import Icon from './Icon.jsx';
import { LEVELS, levelOf, ruleLabel } from '../lib/alerts.js';

export function RiskBadge({ score, size = 'md' }) {
  const level = levelOf(score);
  return (
    <span className={`risk-badge risk-${level} risk-${size}`} title={`${LEVELS[level].label} (${LEVELS[level].range})`}>
      {score}
    </span>
  );
}

export function LevelPill({ score }) {
  const level = levelOf(score);
  return <span className={`level-pill level-${level}`}>{LEVELS[level].label}</span>;
}

export function RuleTag({ code }) {
  return (
    <span className="rule-tag" title={code}>
      {ruleLabel(code)}
    </span>
  );
}

export function UserChip({ name }) {
  return (
    <span className="user-chip">
      <Icon name="user" size={13} />
      {name}
    </span>
  );
}

export function CopyButton({ text, label = 'Sao chép', className = '' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className={`btn btn-ghost btn-sm ${className}`} onClick={copy}>
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {done ? 'Đã chép' : label}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, className = '', bodyClass = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon = 'shield', title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <p className="empty-title">{title}</p>
      {children && <div className="empty-text">{children}</div>}
    </div>
  );
}

// Câu SQL lấy từ log. Nội dung do kẻ tấn công viết ra -> CHỈ render bằng text
// node của React. Đừng đổi sang dangerouslySetInnerHTML để "tô màu cú pháp".
export function SqlBlock({ sql, clamp = false }) {
  if (!sql) return null;
  return <pre className={`sql ${clamp ? 'sql-clamp' : ''}`}>{sql}</pre>;
}
