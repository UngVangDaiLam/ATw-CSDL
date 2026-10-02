import { useMemo } from 'react';
import Icon from '../components/Icon.jsx';
import { Card, EmptyState, LevelPill, RiskBadge, UserChip } from '../components/common.jsx';
import { LEVELS, RULE_CODES, formatLogTime, levelOf, ruleLabel, timeAgo } from '../lib/alerts.js';

export const EMPTY_FILTER = { q: '', rule: '', level: '', user: '', sort: 'new' };

function matches(a, f) {
  if (f.rule && a.rule_triggered !== f.rule) return false;
  if (f.level && levelOf(a.risk_score) !== f.level) return false;
  if (f.user && a.db_user !== f.user) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [a.rule_triggered, ruleLabel(a.rule_triggered), a.db_user, a.detail?.mo_ta, a.detail?.cau_lenh, a.detail?.session_id]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export default function Alerts({ alerts, stats, filter, setFilter, onOpen, newIds, now }) {
  const users = useMemo(() => [...new Set(alerts.map((a) => a.db_user))].sort(), [alerts]);
  const rules = useMemo(() => [...new Set([...RULE_CODES, ...alerts.map((a) => a.rule_triggered)])], [alerts]);

  const list = useMemo(() => {
    const out = alerts.filter((a) => matches(a, filter));
    if (filter.sort === 'risk') out.sort((x, y) => y.risk_score - x.risk_score || y.id - x.id);
    return out;
  }, [alerts, filter]);

  const set = (patch) => setFilter((f) => ({ ...f, ...patch }));
  const active = filter.q || filter.rule || filter.level || filter.user;

  return (
    <div className="page">
      <Card bodyClass="filters">
        <div className="search">
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Tìm theo mô tả, câu lệnh, nhân viên, session_id…"
            value={filter.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        <div className="filter-row">
          <div className="seg" role="group" aria-label="Mức rủi ro">
            <button type="button" className={!filter.level ? 'on' : ''} onClick={() => set({ level: '' })}>Tất cả</button>
            {Object.entries(LEVELS).map(([k, v]) => (
              <button key={k} type="button" className={filter.level === k ? `on on-${k}` : ''} onClick={() => set({ level: filter.level === k ? '' : k })}>
                <span className={`dot seg-${k}`} />{v.label}
              </button>
            ))}
          </div>
          <select value={filter.rule} onChange={(e) => set({ rule: e.target.value })} aria-label="Loại hành vi">
            <option value="">Mọi loại hành vi</option>
            {rules.map((r) => <option key={r} value={r}>{ruleLabel(r)}</option>)}
          </select>
          <select value={filter.user} onChange={(e) => set({ user: e.target.value })} aria-label="Nhân viên">
            <option value="">Mọi nhân viên</option>
            {users.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={filter.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sắp xếp">
            <option value="new">Mới nhất trước</option>
            <option value="risk">Rủi ro cao trước</option>
          </select>
          {active && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilter(EMPTY_FILTER)}>
              <Icon name="x" size={14} /> Bỏ lọc
            </button>
          )}
        </div>
      </Card>

      <div className="list-meta">
        Hiển thị <strong>{list.length}</strong> / {alerts.length} cảnh báo gần nhất
        {stats && stats.total > alerts.length && <span className="muted"> · tổng {stats.total} trong database</span>}
      </div>

      <Card bodyClass="flush">
        {list.length === 0 ? (
          <EmptyState icon={active ? 'search' : 'shield'} title={active ? 'Không có cảnh báo nào khớp bộ lọc' : 'Chưa có cảnh báo nào'}>
            {!active && <>Chạy <code>bash scripts/gen-alerts.sh</code> để sinh cảnh báo mẫu.</>}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="atable">
              <thead>
                <tr>
                  <th className="c-score">Điểm</th>
                  <th>Hành vi</th>
                  <th>Nhân viên</th>
                  <th className="c-stmt">Câu lệnh</th>
                  <th className="c-time">Thời điểm</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr
                    key={a.id}
                    className={`${newIds.has(a.id) ? 'row-new' : ''} row-${levelOf(a.risk_score)}`}
                    onClick={() => onOpen(a)}
                    tabIndex={0}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(a))}
                  >
                    <td className="c-score"><RiskBadge score={a.risk_score} /></td>
                    <td>
                      <div className="cell-title">{ruleLabel(a.rule_triggered)}</div>
                      <div className="cell-sub"><LevelPill score={a.risk_score} /> {a.detail?.mo_ta ? String(a.detail.mo_ta) : ''}</div>
                    </td>
                    <td><UserChip name={a.db_user} /></td>
                    <td className="c-stmt"><code className="stmt-preview">{a.detail?.cau_lenh ? String(a.detail.cau_lenh) : '—'}</code></td>
                    <td className="c-time">
                      <div>{formatLogTime(a.detail?.thoi_diem)}</div>
                      <div className="cell-sub">{timeAgo(a.created_at, now)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
