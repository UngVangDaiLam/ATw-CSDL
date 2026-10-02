import { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Card, CopyButton, EmptyState } from '../components/common.jsx';

const CLASSES = [
  { id: 'read', desc: 'SELECT, COPY FROM', note: 'Rất nhiều log: riêng lần seed 6000 khách đã để lại khoảng 47.000 dòng. Analyzer cần nó cho các rule đọc dữ liệu.', tone: 'warn' },
  { id: 'write', desc: 'INSERT, UPDATE, DELETE, TRUNCATE', note: 'Nên bật: theo dõi mọi thay đổi dữ liệu.', tone: 'ok' },
  { id: 'ddl', desc: 'CREATE / ALTER / DROP', note: 'Nên bật: phát hiện thay đổi cấu trúc trái phép.', tone: 'ok' },
  { id: 'role', desc: 'GRANT, REVOKE, CREATE/ALTER ROLE', note: 'Nên bật: theo dõi thay đổi phân quyền.', tone: 'ok' },
  { id: 'misc_set', desc: 'Các câu SET, nhất là SET ROLE nv_xxx', note: 'Bắt buộc. Cột user trong log luôn là app_user; chỉ nhờ dòng SET ROLE mà analyzer mới biết nhân viên nào đang thao tác.', tone: 'critical' },
  { id: 'function', desc: 'Gọi hàm, khối DO', note: 'Tùy chọn: sinh rất nhiều log, mà số lần giải mã đã đếm được qua câu lệnh lồng nhau.', tone: 'info' },
];

const SETTINGS = [
  { name: 'pgaudit.log', desc: 'Các class được ghi' },
  { name: 'pgaudit.log_relation', desc: 'Một dòng cho mỗi bảng câu lệnh chạm tới', expect: 'on' },
  { name: 'pgaudit.log_parameter', desc: 'Ghi giá trị tham số. PHẢI tắt, nếu không CCCD lọt vào log dạng plaintext', expect: 'off', critical: true },
  { name: 'pgaudit.log_catalog', desc: 'Ghi cả truy vấn vào pg_catalog', expect: 'off' },
  { name: 'pgaudit.log_statement_once', desc: 'Chỉ ghi câu lệnh ở dòng đầu', expect: 'off' },
  { name: 'pgaudit.log_level', desc: 'Mức log của dòng AUDIT' },
  { name: 'pgaudit.role', desc: 'Role dùng cho object audit (READ chọn lọc)' },
  { name: 'log_timezone', desc: 'Múi giờ của log, rule AFTER_HOURS phụ thuộc vào nó', expect: 'Asia/Ho_Chi_Minh' },
];

const SENSITIVE = [
  { table: 'app.customers', tag: 'CCCD mã hóa', tone: 'high' },
  { table: 'app.payments', tag: 'card_token', tone: 'high' },
  { table: 'app.staff', tag: 'password_hash', tone: 'medium' },
  { table: 'app.orders', tag: 'đơn hàng', tone: 'low' },
];

function parseClasses(value) {
  return new Set(String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function selectiveSql(tables) {
  return [
    '-- Object audit: chỉ log SELECT trên các bảng được chọn, thay vì bật class',
    "-- read toàn cục. Đây là BẢN XEM TRƯỚC, chưa áp dụng vào repo.",
    '-- Muốn áp dụng: thêm vào postgres/init/04_grants.sql + postgresql.conf,',
    '-- bỏ "read" khỏi pgaudit.log, rồi chạy scripts/reset.sh và scripts/verify.sh.',
    '',
    'CREATE ROLE pgaudit_reader NOLOGIN;',
    ...tables.map((t) => `GRANT SELECT ON ${t} TO pgaudit_reader;`),
    '',
    "ALTER SYSTEM SET pgaudit.role = 'pgaudit_reader';",
    'SELECT pg_reload_conf();',
  ].join('\n');
}

export default function AuditConfig({ settings }) {
  const live = useMemo(() => parseClasses(settings?.['pgaudit.log']), [settings]);
  const [on, setOn] = useState(() => new Set(['read', 'write', 'ddl', 'role', 'misc_set']));
  const [tables, setTables] = useState(() => new Set(['app.customers', 'app.payments']));

  // Khởi tạo các công tắc theo cấu hình đang chạy thật, khi nó tới.
  useEffect(() => {
    if (settings) setOn(new Set(live));
  }, [settings, live]);

  const toggle = (id) => setOn((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleTable = (t) => setTables((s) => {
    const n = new Set(s);
    n.has(t) ? n.delete(t) : n.add(t);
    return n;
  });

  const generated = `pgaudit.log = '${CLASSES.filter((c) => on.has(c.id)).map((c) => c.id).join(', ')}'`;
  const changed = settings && CLASSES.some((c) => on.has(c.id) !== live.has(c.id));
  const miscOff = !on.has('misc_set');

  return (
    <div className="page">
      <Card
        title="Đang chạy trên server"
        subtitle="Đọc trực tiếp từ pg_settings: sửa postgresql.conf mà chưa restart là thấy ngay ở đây"
        bodyClass="flush"
      >
        {!settings ? (
          <EmptyState icon="database" title="Chưa đọc được cấu hình">Kiểm tra kết nối database ở góc dưới thanh bên.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="stable">
              <tbody>
                {SETTINGS.filter((s) => s.name in settings || s.expect).map((s) => {
                  const v = settings[s.name];
                  const ok = s.expect === undefined || v === s.expect;
                  return (
                    <tr key={s.name} className={!ok && s.critical ? 'row-critical' : ''}>
                      <td><code>{s.name}</code></td>
                      <td className="s-value"><code className={ok ? '' : 'text-danger'}>{v === undefined || v === '' ? '(trống)' : v}</code></td>
                      <td className="s-check">
                        {s.expect !== undefined && (
                          ok
                            ? <span className="check ok"><Icon name="check" size={14} /> đúng</span>
                            : <span className="check bad"><Icon name="alert" size={14} /> cần là {s.expect}</span>
                        )}
                      </td>
                      <td className="muted small">{s.desc}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Thử chọn class"
        subtitle="Bật/tắt để xem giá trị pgaudit.log tương ứng. Không thay đổi gì trên server."
      >
        <div className="classes">
          {CLASSES.map((c) => (
            <label key={c.id} className={`class ${on.has(c.id) ? 'on' : ''} class-${c.tone} ${c.id === 'misc_set' && miscOff ? 'class-danger' : ''}`}>
              <div className="class-head">
                <code>{c.id}</code>
                {settings && live.has(c.id) && <span className="tag">đang bật</span>}
                <span className="switch">
                  <input type="checkbox" checked={on.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="switch-ui" />
                </span>
              </div>
              <div className="class-desc">{c.desc}</div>
              <div className="class-note">{c.note}</div>
            </label>
          ))}
        </div>

        {miscOff && (
          <div className="callout callout-high">
            <Icon name="alert" size={16} />
            <span>Tắt <code>misc_set</code> thì log chỉ còn thấy "app_user đọc bảng customers". Lớp 3 mất khả năng quy trách nhiệm cho từng nhân viên.</span>
          </div>
        )}

        <div className="codebox">
          <div className="codebox-head">
            <span>{changed ? 'Giá trị mới (khác cấu hình đang chạy)' : 'Giá trị tương ứng'}</span>
            <CopyButton text={generated} />
          </div>
          <pre>{generated}</pre>
        </div>
      </Card>

      <Card
        title="READ chọn lọc cho bảng nhạy cảm"
        subtitle="Thay vì log mọi SELECT, dùng pgaudit.role để chỉ log trên vài bảng"
      >
        <div className="tables-pick">
          {SENSITIVE.map((s) => (
            <label key={s.table} className={`pick ${tables.has(s.table) ? 'on' : ''}`}>
              <input type="checkbox" checked={tables.has(s.table)} onChange={() => toggleTable(s.table)} />
              <code>{s.table}</code>
              <span className={`level-pill level-${s.tone}`}>{s.tag}</span>
            </label>
          ))}
        </div>
        {tables.size > 0 && (
          <div className="codebox">
            <div className="codebox-head">
              <span>SQL xem trước</span>
              <CopyButton text={selectiveSql([...tables])} />
            </div>
            <pre>{selectiveSql([...tables])}</pre>
          </div>
        )}
        <p className="note">
          <Icon name="info" size={14} />
          <span>
          Đánh đổi: các rule <code>SQLI_*</code> và <code>STAFF_CREDENTIAL_READ</code> cần thấy cả SELECT trên bảng ngoài danh sách
          (vd. UNION sang <code>app.staff</code>), nên bỏ class <code>read</code> toàn cục sẽ làm chúng mù một phần.
          </span>
        </p>
      </Card>
    </div>
  );
}
