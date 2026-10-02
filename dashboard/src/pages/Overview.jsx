import { useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Card, EmptyState, RiskBadge, UserChip } from '../components/common.jsx';
import { LEVELS, RULES, SESSION_USER, levelOf, ruleLabel, timeAgo } from '../lib/alerts.js';

function Kpi({ icon, label, value, tone, foot }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-icon"><Icon name={icon} size={20} /></div>
      <div className="kpi-main">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">{value ?? '—'}</span>
        {foot && <span className="kpi-foot">{foot}</span>}
      </div>
    </div>
  );
}

// Một chuỗi số theo giờ -> cột dọc, một màu, tooltip theo từng cột.
function Timeline({ data }) {
  const [hover, setHover] = useState(null);
  if (!data?.length) return null;
  const max = Math.max(1, ...data.map((d) => d.n));
  const W = 720, H = 180, padL = 28, padB = 22, padT = 10;
  const bw = (W - padL) / data.length;
  const y = (n) => H - padB - ((H - padB - padT) * n) / max;
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const total = data.reduce((s, d) => s + d.n, 0);

  return (
    <div className="timeline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Số cảnh báo theo giờ trong 24 giờ qua, tổng ${total}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="tl-grid" />
            <text x={padL - 6} y={y(t) + 4} className="tl-axis" textAnchor="end">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * bw;
          const h = H - padB - y(d.n);
          const r = Math.min(4, (bw - 2) / 2, h);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={padT} width={bw} height={H - padB - padT} className="tl-hit" />
              {d.n > 0 && (
                <path
                  className={`tl-bar ${hover === i ? 'hover' : ''}`}
                  d={`M${x + 1},${H - padB} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                />
              )}
              {(i % 3 === 0 || i === data.length - 1) && (
                <text x={x + bw / 2} y={H - 6} className="tl-axis" textAnchor="middle">{d.hour}h</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tl-tip" style={{ left: `${((padL + (hover + 0.5) * bw) / W) * 100}%` }}>
          <strong>{data[hover].n}</strong> cảnh báo
          <span>{data[hover].hour}:00 – {data[hover].hour}:59</span>
        </div>
      )}
    </div>
  );
}

function SeverityBar({ stats }) {
  const total = stats.total || 0;
  const parts = ['high', 'medium', 'low'].map((k) => ({ k, n: stats[k] || 0 }));
  return (
    <div className="sev">
      <div className="sev-track" role="img" aria-label={parts.map((p) => `${LEVELS[p.k].label}: ${p.n}`).join(', ')}>
        {total === 0 && <span className="sev-empty" />}
        {parts.filter((p) => p.n > 0).map((p) => (
          <span key={p.k} className={`sev-seg seg-${p.k}`} style={{ flexGrow: p.n }} title={`${LEVELS[p.k].label}: ${p.n}`} />
        ))}
      </div>
      <div className="sev-legend">
        {parts.map((p) => (
          <div key={p.k} className="sev-item">
            <span className={`sev-swatch seg-${p.k}`} />
            <span className="sev-name">{LEVELS[p.k].label}</span>
            <span className="sev-range">{LEVELS[p.k].range}</span>
            <strong>{p.n}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleBreakdown({ byRule, onPick }) {
  const rows = Object.entries(byRule || {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return <EmptyState title="Chưa có cảnh báo nào" />;
  const max = rows[0][1];
  return (
    <div className="rules">
      {rows.map(([code, n]) => {
        const lvl = levelOf(RULES[code]?.score ?? 0);
        return (
          <button key={code} type="button" className="rule-row" onClick={() => onPick(code)} title={RULES[code]?.hint ?? code}>
            <span className="rule-name">{ruleLabel(code)}</span>
            <span className="rule-track">
              <span className={`rule-fill seg-${lvl}`} style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
            </span>
            <span className="rule-n">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function Overview({ stats, alerts, onOpen, onFilterRule, onFilterUser, onNavigate, now }) {
  const recent = alerts.slice(0, 6);
  const users = stats?.by_user ?? [];
  // Cảnh báo mang tên tài khoản kết nối (app_user) là câu lệnh chạy TRƯỚC khi
  // SET ROLE — chưa quy được cho nhân viên nào, nên không đếm là "nhân viên".
  const staff = users.filter((u) => u.db_user !== SESSION_USER);

  return (
    <div className="page">
      <div className="kpis">
        <Kpi icon="bell" tone="accent" label="Tổng cảnh báo" value={stats?.total} foot="trong audit.alerts" />
        <Kpi icon="alert" tone="high" label="Nghiêm trọng" value={stats?.high} foot="điểm ≥ 80" />
        <Kpi icon="eye" tone="medium" label="Cảnh giác" value={stats?.medium} foot="điểm 60–79" />
        <Kpi icon="user" tone="silver" label="Nhân viên bị gắn cờ" value={stats ? staff.length : null} foot="quy trách nhiệm qua SET ROLE" />
      </div>

      <div className="grid-2-1">
        <Card title="Cảnh báo 24 giờ qua" subtitle="Theo giờ analyzer ghi vào database (giờ Việt Nam)">
          <Timeline data={stats?.timeline} />
        </Card>
        <Card title="Phân mức rủi ro" subtitle="Toàn bộ cảnh báo">
          {stats ? <SeverityBar stats={stats} /> : <div className="skeleton" style={{ height: 120 }} />}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Theo loại hành vi" subtitle="Bấm một dòng để lọc danh sách cảnh báo">
          <RuleBreakdown byRule={stats?.by_rule} onPick={onFilterRule} />
        </Card>
        <Card title="Nhân viên có cảnh báo" subtitle="Danh tính thật sau SET ROLE, không phải app_user">
          {users.length === 0 ? (
            <EmptyState icon="user" title="Chưa có nhân viên nào bị gắn cờ" />
          ) : (
            <div className="users">
              {users.slice(0, 6).map((u) => (
                <button key={u.db_user} type="button" className="user-row" onClick={() => onFilterUser(u.db_user)}>
                  <UserChip name={u.db_user} />
                  <span className="muted small">
                    {u.n} cảnh báo
                    {u.db_user === SESSION_USER && <span className="pre-role"> · trước khi SET ROLE</span>}
                  </span>
                  <span className="user-max">cao nhất <RiskBadge score={u.max_risk} size="sm" /></span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Mới nhất"
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('alerts')}>
            Xem tất cả <Icon name="chevron" size={14} />
          </button>
        }
        bodyClass="flush"
      >
        {recent.length === 0 ? (
          <EmptyState title="Chưa có cảnh báo nào">
            Chạy <code>bash scripts/gen-alerts.sh</code> để diễn lại các hành vi tấn công mẫu.
          </EmptyState>
        ) : (
          <ul className="feed">
            {recent.map((a) => (
              <li key={a.id}>
                <button type="button" className="feed-row" onClick={() => onOpen(a)}>
                  <RiskBadge score={a.risk_score} />
                  <div className="feed-main">
                    <span className="feed-title">{ruleLabel(a.rule_triggered)}</span>
                    <span className="feed-desc">{a.detail?.mo_ta ? String(a.detail.mo_ta) : ''}</span>
                  </div>
                  <UserChip name={a.db_user} />
                  <span className="feed-time">{timeAgo(a.created_at, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
