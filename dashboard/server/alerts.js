// Đọc audit.alerts bằng dashboard_user. Toàn bộ câu SQL của dashboard nằm ở
// file này — role chỉ có SELECT trên đúng một bảng, nên mọi thứ khác (ghi,
// đánh dấu đã xử lý, đọc schema app) sẽ bị database từ chối chứ không phải
// do code tự kiềm chế.
//
// Mỗi câu lệnh ở đây cũng sinh một dòng AUDIT trong log pgAudit (class read).
// Analyzer không coi audit.alerts là bảng nhạy cảm nên không tự báo động về
// chính dashboard, nhưng đó là lý do không poll dày hơn mức cần.

import pg from 'pg';
import config from './config.js';

// bigint -> Number. id của alerts không bao giờ chạm 2^53, còn để mặc định
// thì pg trả chuỗi và so sánh "10" > "9" ở phía client sẽ sai.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool(config.db);
pool.on('error', (err) => {
  console.error('[db] loi tu pool:', err.message);
});

const COLUMNS = 'id, db_user, rule_triggered, risk_score, detail, created_at';

function toClient(row) {
  return { ...row, created_at: row.created_at?.toISOString?.() ?? row.created_at };
}

// Database dang replay WAL (PITR, xem backup/scripts/pitr_restore.sh) van cho
// DOC (hot standby), nhung du lieu luc do la trang thai DO DANG cua qua trinh
// khoi phuc. Doc trung luc ay, dashboard tuong bang bi lam lai (max id tut ve
// vai tram), keo con tro lui, roi khi khoi phuc xong day lai hang tram canh bao
// CU xuong trinh duyet nhu canh bao moi (da tai hien: 409 canh bao "moi").
export async function inRecovery() {
  const { rows } = await pool.query('SELECT pg_is_in_recovery() AS r');
  return rows[0].r === true;
}

export async function latestAlerts(limit) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM audit.alerts ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows.map(toClient);
}

// Con trỏ là khóa chính, không phải created_at: hai cảnh báo có thể cùng mốc
// thời gian, còn id thì tăng nghiêm ngặt.
export async function alertsAfter(lastId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM audit.alerts WHERE id > $1 ORDER BY id LIMIT $2`,
    [lastId, limit]
  );
  return rows.map(toClient);
}

// Gộp mọi con số thống kê vào MỘT câu lệnh — một dòng AUDIT thay vì năm.
export async function stats() {
  const { rows } = await pool.query(`
    WITH a AS (SELECT id, db_user, rule_triggered, risk_score, created_at FROM audit.alerts)
    SELECT
      (SELECT count(*)::int FROM a)                                      AS total,
      (SELECT count(*)::int FROM a WHERE risk_score >= 80)               AS high,
      (SELECT count(*)::int FROM a WHERE risk_score BETWEEN 60 AND 79)   AS medium,
      (SELECT count(*)::int FROM a WHERE risk_score < 60)                AS low,
      (SELECT coalesce(max(id), 0) FROM a)                               AS max_id,
      (SELECT coalesce(json_object_agg(rule_triggered, n), '{}')
         FROM (SELECT rule_triggered, count(*)::int AS n FROM a GROUP BY 1) r) AS by_rule,
      (SELECT coalesce(json_agg(u ORDER BY u.max_risk DESC, u.n DESC), '[]')
         FROM (SELECT db_user, count(*)::int AS n, max(risk_score)::int AS max_risk
                 FROM a GROUP BY 1) u)                                  AS by_user,
      (SELECT json_agg(json_build_object('hour', to_char(h, 'HH24'), 'n', coalesce(c.n, 0)) ORDER BY h)
         FROM generate_series(
                date_trunc('hour', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '23 hours',
                date_trunc('hour', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'),
                interval '1 hour') AS h
         LEFT JOIN (SELECT date_trunc('hour', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS b,
                           count(*)::int AS n
                      FROM a GROUP BY 1) c ON c.b = h)                  AS timeline
  `);
  return rows[0];
}

// Cấu hình pgAudit đang chạy thật, đọc từ pg_settings (catalog công khai,
// không cần thêm GRANT). Trang "Cấu hình pgAudit" hiển thị số liệu này thay vì
// chép tay postgresql.conf — sửa conf mà quên restart là thấy ngay.
export async function auditSettings() {
  const { rows } = await pool.query(`
    SELECT name, setting
    FROM pg_settings
    WHERE name LIKE 'pgaudit.%' OR name IN ('log_timezone', 'shared_preload_libraries')
    ORDER BY name
  `);
  return Object.fromEntries(rows.map((r) => [r.name, r.setting]));
}
