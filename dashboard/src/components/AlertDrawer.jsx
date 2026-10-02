import { useEffect } from 'react';
import Icon from './Icon.jsx';
import { CopyButton, LevelPill, RiskBadge, SqlBlock } from './common.jsx';
import { RULES, formatDateTime, formatLogTime, ruleLabel } from '../lib/alerts.js';

// Các khóa đã có chỗ hiển thị riêng — phần còn lại của detail rơi xuống bảng
// "Trường khác" để không mất thông tin khi analyzer thêm khóa mới.
const SHOWN = new Set(['mo_ta', 'cau_lenh', 'thoi_diem', 'session_user', 'client', 'session_id', 'pid', 'bang', 'so_ban_ghi_giai_ma', 'gio', 'thu_trong_tuan', 'nguon', 'tai_khoan', 'so_lan', 'su_kien', 'duong_dan', 'khoa_theo', 'ly_do', 'phien_cua']);
// Nhan tieng Viet cho cac truong cua canh bao tu tang web (analyzer/src/appEvents.js).
const WEB_LABELS = { su_kien: 'Sự kiện', duong_dan: 'Request', khoa_theo: 'Khóa theo', ly_do: 'Lý do chặn', phien_cua: 'Phiên đăng nhập kèm theo' };
const WEB_VALUES = { tai_khoan: 'cặp (IP, tài khoản)', ip: 'cả địa chỉ IP', content_type: 'gửi dạng form, không phải JSON', token_missing: 'thiếu CSRF token', token_mismatch: 'sai CSRF token' };
const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

function asText(v) {
  if (v === null || v === undefined) return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function Field({ label, children, mono = false }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>{children}</dd>
    </div>
  );
}

export default function AlertDrawer({ alert, onClose }) {
  useEffect(() => {
    if (!alert) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [alert, onClose]);

  const open = Boolean(alert);
  const d = alert?.detail ?? {};
  // Canh bao tu tang web (analyzer/src/appEvents.js) khong co cau SQL hay SET ROLE.
  const fromWeb = d.nguon === 'app';
  const extra = Object.entries(d).filter(([k]) => !SHOWN.has(k));

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open} role="dialog" aria-label="Chi tiết cảnh báo">
        {alert && (
          <>
            <header className="drawer-head">
              <RiskBadge score={alert.risk_score} size="lg" />
              <div className="drawer-title">
                <span className="drawer-kicker">Cảnh báo #{alert.id}</span>
                <h2>{ruleLabel(alert.rule_triggered)}</h2>
                <div className="drawer-meta">
                  <LevelPill score={alert.risk_score} />
                  <code>{alert.rule_triggered}</code>
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={onClose} aria-label="Đóng">
                <Icon name="x" />
              </button>
            </header>

            <div className="drawer-body">
              {d.mo_ta && <p className="drawer-desc">{asText(d.mo_ta)}</p>}
              {RULES[alert.rule_triggered] && <p className="drawer-hint"><Icon name="info" size={14} />{RULES[alert.rule_triggered].hint}</p>}

              {fromWeb ? (
                <>
                  <h3 className="drawer-section">Nguồn</h3>
                  <div className="identity">
                    <div className="identity-box identity-real">
                      <span className="identity-label">Tầng web (app/)</span>
                      <span className="identity-value">{asText(d.client)}</span>
                      <span className="identity-note">địa chỉ IP gửi request</span>
                    </div>
                    {d.tai_khoan != null && (
                      <>
                        <Icon name="chevron" className="identity-arrow" />
                        <div className="identity-box">
                          <span className="identity-label">Tài khoản bị dò</span>
                          <span className="identity-value">{asText(d.tai_khoan)}</span>
                          <span className="identity-note">{asText(d.so_lan)} lần sai</span>
                        </div>
                      </>
                    )}
                  </div>
                  <p className="identity-caption">
                    Sự kiện xảy ra ở tầng HTTP nên không có trong log pgAudit: app ghi ra logs/app/, analyzer đọc và ghi
                    cảnh báo. App không có quyền gì trên bảng cảnh báo.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="drawer-section">Ai đã làm?</h3>
                  <div className="identity">
                    <div className="identity-box identity-real">
                      <span className="identity-label">Nhân viên thật</span>
                      <span className="identity-value">{alert.db_user}</span>
                      <span className="identity-note">từ <code>SET ROLE</code> trong phiên</span>
                    </div>
                    <Icon name="chevron" className="identity-arrow" />
                    <div className="identity-box">
                      <span className="identity-label">Tài khoản kết nối</span>
                      <span className="identity-value">{asText(d.session_user ?? 'app_user')}</span>
                      <span className="identity-note">cột <code>user</code> trong log</span>
                    </div>
                  </div>
                  <p className="identity-caption">
                    Log chỉ ghi tài khoản kết nối chung của ứng dụng. Analyzer bám theo phiên để quy về đúng nhân viên.
                  </p>
                </>
              )}

              {d.cau_lenh && (
                <>
                  <h3 className="drawer-section">
                    Câu lệnh
                    <CopyButton text={asText(d.cau_lenh)} />
                  </h3>
                  <SqlBlock sql={asText(d.cau_lenh)} />
                  <p className="muted small">Số CCCD / số thẻ (chuỗi ≥ 9 chữ số) đã được che trước khi ghi cảnh báo.</p>
                </>
              )}

              <h3 className="drawer-section">Bối cảnh</h3>
              <dl className="fields">
                <Field label="Thời điểm hành vi">{formatLogTime(d.thoi_diem)}</Field>
                <Field label="Analyzer ghi lúc">{formatDateTime(alert.created_at)}</Field>
                {d.so_ban_ghi_giai_ma !== undefined && (
                  <Field label="Bản ghi bị giải mã"><strong className="text-danger">{asText(d.so_ban_ghi_giai_ma)}</strong></Field>
                )}
                {d.bang && (
                  <Field label="Bảng">
                    <span className="table-list">
                      {(Array.isArray(d.bang) ? d.bang : [d.bang]).map((t) => <code key={asText(t)}>{asText(t)}</code>)}
                    </span>
                  </Field>
                )}
                {d.gio !== undefined && <Field label="Giờ">{asText(d.gio)}</Field>}
                {d.thu_trong_tuan !== undefined && <Field label="Ngày">{WEEKDAYS[d.thu_trong_tuan] ?? asText(d.thu_trong_tuan)}</Field>}
                <Field label="IP nguồn" mono>{asText(d.client)}</Field>
                {fromWeb ? (
                  Object.entries(WEB_LABELS).filter(([k]) => d[k] !== undefined).map(([k, label]) => (
                    <Field key={k} label={label} mono={k === 'duong_dan' || k === 'phien_cua'}>
                      {WEB_VALUES[d[k]] ?? asText(d[k])}
                    </Field>
                  ))
                ) : (
                  <>
                    <Field label="session_id" mono>{asText(d.session_id)}</Field>
                    <Field label="pid" mono>{asText(d.pid)}</Field>
                  </>
                )}
                {extra.map(([k, v]) => <Field key={k} label={k} mono>{asText(v)}</Field>)}
              </dl>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
