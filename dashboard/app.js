// =============================================================================
//  SecDB Dashboard — Application Logic
//  Cấu hình pgAudit & Script phân tích Log
//
//  Đọc và mô phỏng hoạt động của analyzer từ project ATw-CSDL:
//  - Cấu hình pgAudit: rà lại mức log (write, ddl, role), cân nhắc bật read
//    chọn lọc cho bảng nhạy cảm
//  - Script phân tích log: phát hiện SELECT toàn bảng + truy vấn ngoài giờ
// =============================================================================

// ─── MOCK DATA (dựa trên cấu trúc thật của analyzer & postgresql.conf) ──────
// Trong production, dữ liệu này đến từ analyzer đọc file .json trong ./logs/

const MOCK_ALERTS = generateMockAlerts();
const MOCK_LOG_LINES = generateMockLogLines();

// ─── STATE ──────────────────────────────────────────────────────────────────
let currentSection = 'overview';
let allAlerts = MOCK_ALERTS;
let analysisRunning = false;

// ─── INITIALIZATION ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initClock();
  updateOverviewStats();
  renderRuleBars();
  renderRecentAlerts();
  renderAlertsView();
  updateLogClassUI();

  // Refresh button
  document.getElementById('btn-refresh').addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh');
    btn.querySelector('svg').classList.add('spin');
    setTimeout(() => {
      btn.querySelector('svg').classList.remove('spin');
      updateOverviewStats();
      renderRuleBars();
      renderRecentAlerts();
    }, 800);
  });

  // Copy buttons
  document.getElementById('btn-copy-config')?.addEventListener('click', () => {
    copyToClipboard(document.getElementById('current-config-display').textContent);
  });
  document.getElementById('btn-copy-generated')?.addEventListener('click', () => {
    copyToClipboard(document.getElementById('gen-config-output').textContent);
  });
  document.getElementById('btn-copy-selective')?.addEventListener('click', () => {
    copyToClipboard(document.getElementById('selective-read-output').textContent);
  });

  // Menu toggle (mobile)
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
});

// ─── NAVIGATION ─────────────────────────────────────────────────────────────
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const section = item.dataset.section;
      if (!section) return;
      switchSection(section);

      // Mobile: close sidebar
      document.getElementById('sidebar').classList.remove('open');
    });
  });
}

function switchSection(section) {
  currentSection = section;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-section="${section}"]`)?.classList.add('active');

  // Update sections
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  const sectionEl = document.getElementById(`section-${section}`);
  if (sectionEl) sectionEl.classList.add('active');

  // Update header
  const titles = {
    'overview':       { title: 'Tổng quan Hệ thống', sub: 'Dashboard giám sát bảo mật CSDL nhiều lớp trên PostgreSQL' },
    'pgaudit-config': { title: 'Cấu hình pgAudit', sub: 'Rà lại mức log — write, ddl, role — cân nhắc bật thêm read chọn lọc' },
    'log-analysis':   { title: 'Phân tích Log pgAudit', sub: 'Phát hiện SELECT toàn bảng & truy vấn ngoài giờ hành chính' },
    'alerts-view':    { title: 'Cảnh báo Bảo mật', sub: 'Tất cả cảnh báo phát hiện bởi analyzer — sắp xếp theo mức độ rủi ro' },
  };

  const t = titles[section] || titles['overview'];
  document.getElementById('page-title').textContent = t.title;
  document.getElementById('page-subtitle').textContent = t.sub;
}

// ─── CLOCK ──────────────────────────────────────────────────────────────────
function initClock() {
  function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('clock').textContent = `${hh}:${mm}:${ss}`;
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// ─── OVERVIEW STATS ─────────────────────────────────────────────────────────
function updateOverviewStats() {
  animateCounter('val-total-logs', MOCK_LOG_LINES.length);
  animateCounter('val-alerts', allAlerts.length);
  animateCounter('val-after-hours', allAlerts.filter(a => a.rule_triggered === 'AFTER_HOURS').length);
  animateCounter('val-full-table', allAlerts.filter(a => a.rule_triggered === 'FULL_TABLE_READ').length);
  document.getElementById('alert-count-badge').textContent = allAlerts.length;
}

function animateCounter(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const duration = 600;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ─── RULE BARS ──────────────────────────────────────────────────────────────
function renderRuleBars() {
  const container = document.getElementById('rule-bars');
  if (!container) return;

  const counts = {};
  allAlerts.forEach(a => {
    counts[a.rule_triggered] = (counts[a.rule_triggered] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = sorted.length > 0 ? sorted[0][1] : 1;

  const fillClasses = {
    'SQLI_UNION': 'fill-danger',
    'SQLI_TAUTOLOGY': 'fill-danger',
    'SQLI_SCHEMA_PROBE': 'fill-danger',
    'BULK_DECRYPT': 'fill-danger',
    'STAFF_CREDENTIAL_READ': 'fill-warning',
    'FULL_TABLE_READ': 'fill-info',
    'AFTER_HOURS': 'fill-accent',
  };

  container.innerHTML = sorted.map(([rule, count]) => {
    const pct = Math.max(5, (count / max) * 100);
    const cls = fillClasses[rule] || 'fill-accent';
    return `
      <div class="rule-bar-item">
        <span class="rule-bar-name">${rule}</span>
        <div class="rule-bar-track">
          <div class="rule-bar-fill ${cls}" style="width:${pct}%">${count}</div>
        </div>
      </div>
    `;
  }).join('');

  if (sorted.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Chưa có cảnh báo nào</p></div>';
  }
}

// ─── RECENT ALERTS ──────────────────────────────────────────────────────────
function renderRecentAlerts() {
  const container = document.getElementById('recent-alerts');
  if (!container) return;

  const recent = [...allAlerts].sort((a, b) => b.risk_score - a.risk_score).slice(0, 8);

  container.innerHTML = recent.map(a => {
    const riskClass = a.risk_score >= 70 ? 'risk-high' : a.risk_score >= 40 ? 'risk-medium' : 'risk-low';
    return `
      <div class="recent-alert-item">
        <div class="alert-risk-badge ${riskClass}">${a.risk_score}</div>
        <div class="alert-content">
          <div class="alert-rule-name">${a.rule_triggered}</div>
          <div class="alert-desc">${a.detail?.mo_ta || ''}</div>
        </div>
        <div class="alert-time">${a.db_user}</div>
      </div>
    `;
  }).join('');

  if (recent.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Chưa có cảnh báo nào</p></div>';
  }
}

// ─── pgAudit CONFIG ─────────────────────────────────────────────────────────
function updateLogClass() {
  updateLogClassUI();
  updateGeneratedConfig();
}

function updateLogClassUI() {
  const classes = ['read', 'write', 'ddl', 'role', 'misc', 'function'];

  classes.forEach(cls => {
    const cb = document.getElementById(`cb-${cls}`);
    const card = document.getElementById(`lc-${cls}`);
    const badge = card?.querySelector('.lc-badge');

    if (!cb || !card) return;

    if (cb.checked) {
      card.classList.add('active');
      if (badge && !badge.classList.contains('lc-critical')) {
        badge.textContent = 'BẬT';
        badge.className = 'lc-badge lc-enabled';
      }
    } else {
      card.classList.remove('active');
      if (badge && !badge.classList.contains('lc-critical')) {
        badge.textContent = 'TẮT';
        badge.className = 'lc-badge lc-disabled';
      }
    }
  });

  // misc_set warning
  const miscCb = document.getElementById('cb-misc');
  if (miscCb && !miscCb.checked) {
    const miscCard = document.getElementById('lc-misc');
    if (miscCard) {
      miscCard.classList.add('critical-card');
      const badge = miscCard.querySelector('.lc-badge');
      if (badge) {
        badge.textContent = '⚠ NGUY HIỂM';
        badge.className = 'lc-badge lc-critical';
      }
    }
  } else {
    const miscCard = document.getElementById('lc-misc');
    if (miscCard) {
      miscCard.classList.add('critical-card');
      const badge = miscCard.querySelector('.lc-badge');
      if (badge) {
        badge.textContent = 'BẮT BUỘC';
        badge.className = 'lc-badge lc-critical';
      }
    }
  }

  // Show/hide selective read options based on read checkbox
  const readCb = document.getElementById('cb-read');
  const readOptions = document.getElementById('read-sensitive-options');
  if (readCb && readOptions) {
    readOptions.style.display = readCb.checked ? 'block' : 'none';
  }

  updateGeneratedConfig();
}

function updateGeneratedConfig() {
  const classes = [];
  if (document.getElementById('cb-read')?.checked) classes.push('read');
  if (document.getElementById('cb-write')?.checked) classes.push('write');
  if (document.getElementById('cb-role')?.checked) classes.push('role');
  if (document.getElementById('cb-ddl')?.checked) classes.push('ddl');
  if (document.getElementById('cb-misc')?.checked) classes.push('misc_set');
  if (document.getElementById('cb-function')?.checked) classes.push('function');

  const output = document.getElementById('gen-config-output');
  if (output) {
    output.textContent = `pgaudit.log = '${classes.join(', ')}'`;
  }

  updateSensitiveConfig();
}

function updateSensitiveConfig() {
  const readCb = document.getElementById('cb-read');
  const selectiveDiv = document.getElementById('selective-read-config');

  if (!readCb?.checked) {
    if (selectiveDiv) selectiveDiv.style.display = 'none';
    return;
  }

  const checkedTables = [];
  document.querySelectorAll('#read-sensitive-options input[type="checkbox"]:checked').forEach(cb => {
    checkedTables.push(cb.dataset.table);
  });

  if (checkedTables.length === 0) {
    if (selectiveDiv) selectiveDiv.style.display = 'none';
    return;
  }

  if (selectiveDiv) selectiveDiv.style.display = 'block';

  const sql = generateSelectiveReadSQL(checkedTables);
  const output = document.getElementById('selective-read-output');
  if (output) output.textContent = sql;
}

function generateSelectiveReadSQL(tables) {
  // Giải thích: thay vì bật read toàn cục (rất ồn ào), dùng OBJECT AUDIT
  // qua pgaudit.role để chỉ log SELECT trên bảng nhạy cảm.
  let sql = `-- =============================================================================
-- Cấu hình Object Audit: bật READ chọn lọc cho bảng nhạy cảm
-- Thay vì pgaudit.log = 'read, ...' (log TẤT CẢ SELECT), dùng pgaudit.role
-- để CHỈ log SELECT trên các bảng được chỉ định.
-- =============================================================================

-- Bước 1: Tạo role dùng cho Object Audit
CREATE ROLE pgaudit_read_role NOLOGIN;

-- Bước 2: Cấp SELECT cho role đó trên các bảng nhạy cảm
`;

  tables.forEach(t => {
    sql += `GRANT SELECT ON ${t} TO pgaudit_read_role;\n`;
  });

  sql += `
-- Bước 3: Khai báo trong postgresql.conf
-- pgaudit.role = 'pgaudit_read_role'
--
-- Khi đó, CHỈ CÓ SELECT trên các bảng đã GRANT mới sinh ra dòng AUDIT,
-- giảm đáng kể lượng log so với bật read toàn cục.
--
-- LƯU Ý: cần restart PostgreSQL sau khi thay đổi pgaudit.role
--   docker compose restart postgres`;

  return sql;
}

// ─── LOG ANALYSIS ───────────────────────────────────────────────────────────
function runAnalysis(dryRun = false) {
  if (analysisRunning) return;
  analysisRunning = true;

  const console_el = document.getElementById('console-output');
  console_el.innerHTML = '';

  const bhStart = parseInt(document.getElementById('bh-start')?.value) || 7;
  const bhEnd = parseInt(document.getElementById('bh-end')?.value) || 19;

  logToConsole('highlight', `═══ Bắt đầu phân tích log pgAudit ${dryRun ? '(DRY RUN)' : ''} ═══`);
  logToConsole('info', `Thư mục log: ./logs/`);
  logToConsole('info', `Giờ hành chính: ${bhStart}h - ${bhEnd}h`);
  logToConsole('info', `Bảng nhạy cảm: app.customers, app.payments`);
  logToConsole('info', `Bộ lọc: substatement_id = 1 (chỉ câu lệnh client)`);
  logToConsole('separator');

  // Simulate reading log files
  let lineIndex = 0;
  const alerts = [];
  const totalLines = MOCK_LOG_LINES.length;
  let statementCount = 0;
  let skippedLocal = 0;

  // Track sessions (mô phỏng sessions.js)
  const sessionRoles = {};

  function processChunk() {
    const chunkSize = Math.min(10, totalLines - lineIndex);

    for (let i = 0; i < chunkSize && lineIndex < totalLines; i++, lineIndex++) {
      const line = MOCK_LOG_LINES[lineIndex];

      // Skip local socket
      if (line.remote_host === '[local]') {
        skippedLocal++;
        continue;
      }

      // Track SET ROLE
      if (line.audit_class === 'MISC' && line.command === 'SET' && line.statement) {
        const roleMatch = line.statement.match(/SET\s+(?:LOCAL\s+)?ROLE\s+(\w+)/i);
        if (roleMatch) {
          const sessionId = line.session_id || `pid-${line.pid}`;
          sessionRoles[sessionId] = roleMatch[1];
          logToConsole('info', `Phiên ${sessionId}: SET ROLE → ${roleMatch[1]}`);
        }
      }

      // Only process substatement_id === 1 (client-level statements)
      if (line.substatement_id !== 1) continue;

      statementCount++;
      const sessionId = line.session_id || `pid-${line.pid}`;
      const actor = sessionRoles[sessionId] || line.user || 'app_user';

      // Parse timestamp hour
      const tsMatch = (line.timestamp || '').match(/(\d{2}):(\d{2}):(\d{2})/);
      const hour = tsMatch ? parseInt(tsMatch[1]) : 12;

      // Rule: FULL_TABLE_READ — SELECT toàn bảng nhạy cảm
      if (line.audit_class === 'READ' && line.command === 'SELECT') {
        const sensitives = ['app.customers', 'app.payments'];
        const hitTable = sensitives.find(t => (line.object_name || '').includes(t) || (line.statement || '').toLowerCase().includes(t));

        if (hitTable) {
          const hasWhere = /\bwhere\b/i.test(line.statement || '');
          const isCountOnly = /^\s*select\s+count\s*\(/i.test(line.statement || '');

          if (!hasWhere && !isCountOnly) {
            const alert = {
              db_user: actor,
              rule_triggered: 'FULL_TABLE_READ',
              risk_score: 60,
              detail: {
                mo_ta: `Đọc bảng nhạy cảm ${hitTable} mà không có điều kiện lọc (WHERE)`,
                cau_lenh: redactStatement(line.statement || ''),
                session_id: sessionId,
                thoi_diem: line.timestamp,
                bang: [hitTable],
              },
            };
            alerts.push(alert);
            logToConsole('alert', `[60] FULL_TABLE_READ        ${actor.padEnd(14)} ${line.timestamp}`);
            logToConsole('warning', `     Đọc bảng nhạy cảm mà không có WHERE`);
            logToConsole('info', `     ${redactStatement(line.statement || '')}`);
          }
        }
      }

      // Rule: AFTER_HOURS — truy cập ngoài giờ hành chính
      if ((line.audit_class === 'READ' || line.audit_class === 'WRITE') && (hour < bhStart || hour >= bhEnd)) {
        const sensitives = ['app.customers', 'app.payments', 'app.staff'];
        const hitTable = sensitives.find(t => (line.object_name || '').includes(t) || (line.statement || '').toLowerCase().includes(t));

        if (hitTable) {
          const alert = {
            db_user: actor,
            rule_triggered: 'AFTER_HOURS',
            risk_score: 40,
            detail: {
              mo_ta: `Truy cập dữ liệu ngoài giờ hành chính: ${hour}:${tsMatch ? tsMatch[2] : '00'} nằm ngoài khung ${bhStart}h-${bhEnd}h`,
              cau_lenh: redactStatement(line.statement || ''),
              session_id: sessionId,
              thoi_diem: line.timestamp,
              gio: `${hour}:${tsMatch ? tsMatch[2] : '00'}`,
              bang: [hitTable],
            },
          };
          alerts.push(alert);
          logToConsole('alert', `[40] AFTER_HOURS            ${actor.padEnd(14)} ${line.timestamp}`);
          logToConsole('warning', `     Truy cập ngoài giờ: ${hour}h (khung ${bhStart}h-${bhEnd}h)`);
          logToConsole('info', `     ${redactStatement(line.statement || '')}`);
        }
      }

      // Rule: SQLI_UNION — dấu vết SQL Injection
      if ((line.audit_class === 'READ' || line.audit_class === 'WRITE') && /\bunion\b[\s\S]{0,200}?\bselect\b/i.test(line.statement || '')) {
        const alert = {
          db_user: actor,
          rule_triggered: 'SQLI_UNION',
          risk_score: 90,
          detail: {
            mo_ta: 'Câu lệnh chứa UNION SELECT — dấu hiệu khai thác SQL Injection',
            cau_lenh: redactStatement(line.statement || ''),
            session_id: sessionId,
            thoi_diem: line.timestamp,
          },
        };
        alerts.push(alert);
        logToConsole('error', `[90] SQLI_UNION             ${actor.padEnd(14)} ${line.timestamp}`);
        logToConsole('error', `     ⚠ UNION SELECT — Dấu hiệu SQL Injection!`);
        logToConsole('info', `     ${redactStatement(line.statement || '')}`);
      }

      // Rule: STAFF_CREDENTIAL_READ
      if (line.audit_class === 'READ' && (line.object_name || '').includes('app.staff') && sessionRoles[sessionId]) {
        const alert = {
          db_user: actor,
          rule_triggered: 'STAFF_CREDENTIAL_READ',
          risk_score: 75,
          detail: {
            mo_ta: `Phiên đã SET ROLE sang ${actor} nhưng vẫn đọc app.staff (bảng chứa password_hash)`,
            cau_lenh: redactStatement(line.statement || ''),
            session_id: sessionId,
            thoi_diem: line.timestamp,
          },
        };
        alerts.push(alert);
        logToConsole('error', `[75] STAFF_CREDENTIAL_READ  ${actor.padEnd(14)} ${line.timestamp}`);
        logToConsole('warning', `     Đọc bảng nhân viên sau khi đã SET ROLE`);
      }
    }

    // Progress
    const pct = Math.round((lineIndex / totalLines) * 100);
    if (lineIndex < totalLines) {
      if (lineIndex % 20 === 0) {
        logToConsole('info', `Đang xử lý... ${pct}% (${lineIndex}/${totalLines} dòng)`);
      }
      setTimeout(processChunk, 80);
    } else {
      // Done
      logToConsole('separator');
      logToConsole('highlight', '════════════════════════════════════════════');
      logToConsole('success', `Đọc      : ${lineIndex} dòng log mới, ${statementCount} câu lệnh`);
      logToConsole('info', `Bỏ qua   : ${skippedLocal} câu lệnh qua unix socket (quản trị/init)`);
      logToConsole('warning', `Cảnh báo : ${alerts.length}`);

      // Count by rule
      const byRule = {};
      alerts.forEach(a => {
        byRule[a.rule_triggered] = (byRule[a.rule_triggered] || 0) + 1;
      });
      Object.entries(byRule).sort((a, b) => b[1] - a[1]).forEach(([rule, n]) => {
        logToConsole('info', `           ${rule.padEnd(22)} ${n}`);
      });

      logToConsole('success', dryRun
        ? 'Chế độ   : --dry-run, KHÔNG ghi vào audit.alerts'
        : `Đã ghi   : ${alerts.length} dòng vào audit.alerts`);
      logToConsole('highlight', '════════════════════════════════════════════');

      // Update main state
      allAlerts = alerts;
      updateOverviewStats();
      renderRuleBars();
      renderRecentAlerts();
      renderAlertsView();
      showAnalysisResults(alerts, statementCount, lineIndex, skippedLocal);

      analysisRunning = false;
    }
  }

  // Start processing
  setTimeout(processChunk, 300);
}

function showAnalysisResults(alerts, stmtCount, lineCount, skipped) {
  const card = document.getElementById('analysis-results-card');
  if (!card) return;
  card.style.display = 'block';

  document.getElementById('result-timestamp').textContent = new Date().toLocaleString('vi-VN');

  const summary = document.getElementById('result-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="result-stat">
        <span class="result-stat-value" style="color:var(--accent-light)">${lineCount.toLocaleString()}</span>
        <span class="result-stat-label">Dòng log</span>
      </div>
      <div class="result-stat">
        <span class="result-stat-value" style="color:var(--text-primary)">${stmtCount.toLocaleString()}</span>
        <span class="result-stat-label">Câu lệnh</span>
      </div>
      <div class="result-stat">
        <span class="result-stat-value" style="color:var(--danger)">${alerts.length}</span>
        <span class="result-stat-label">Cảnh báo</span>
      </div>
      <div class="result-stat">
        <span class="result-stat-value" style="color:var(--text-muted)">${skipped}</span>
        <span class="result-stat-label">Bỏ qua (socket)</span>
      </div>
    `;
  }

  const tbody = document.getElementById('result-table-body');
  if (tbody) {
    const sorted = [...alerts].sort((a, b) => b.risk_score - a.risk_score);
    tbody.innerHTML = sorted.slice(0, 50).map(a => {
      const riskClass = a.risk_score >= 70 ? 'high' : a.risk_score >= 40 ? 'medium' : 'low';
      return `
        <tr>
          <td class="risk-score-cell ${riskClass}">${a.risk_score}</td>
          <td class="rule-cell">${a.rule_triggered}</td>
          <td class="user-cell">${a.db_user}</td>
          <td>${a.detail?.thoi_diem || ''}</td>
          <td>${a.detail?.mo_ta || ''}</td>
          <td class="stmt-cell" title="${(a.detail?.cau_lenh || '').replace(/"/g, '&quot;')}">${a.detail?.cau_lenh || ''}</td>
        </tr>
      `;
    }).join('');
  }
}

// ─── ALERTS VIEW ────────────────────────────────────────────────────────────
function renderAlertsView() {
  const container = document.getElementById('alerts-list');
  if (!container) return;

  const sorted = [...allAlerts].sort((a, b) => b.risk_score - a.risk_score);

  container.innerHTML = sorted.map(a => {
    const level = a.risk_score >= 70 ? 'high' : a.risk_score >= 40 ? 'medium' : 'low';
    return `
      <div class="alert-card alert-${level}">
        <div class="alert-card-score">${a.risk_score}</div>
        <div class="alert-card-body">
          <div class="alert-card-header">
            <span class="alert-card-rule">${a.rule_triggered}</span>
            <span class="alert-card-user">${a.db_user}</span>
            <span class="alert-card-time">${a.detail?.thoi_diem || ''}</span>
          </div>
          <div class="alert-card-desc">${a.detail?.mo_ta || ''}</div>
          ${a.detail?.cau_lenh ? `<div class="alert-card-stmt">${a.detail.cau_lenh}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (sorted.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:60px 20px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <p>Chưa có cảnh báo nào. Chạy phân tích log để bắt đầu.</p>
      </div>
    `;
  }
}

function filterAlerts() {
  const ruleFilter = document.getElementById('filter-rule')?.value || '';
  const riskFilter = document.getElementById('filter-risk')?.value || '';
  const userFilter = (document.getElementById('filter-user')?.value || '').toLowerCase().trim();

  let filtered = [...allAlerts];

  if (ruleFilter) filtered = filtered.filter(a => a.rule_triggered === ruleFilter);
  if (userFilter) filtered = filtered.filter(a => (a.db_user || '').toLowerCase().includes(userFilter));
  if (riskFilter === 'high') filtered = filtered.filter(a => a.risk_score >= 70);
  else if (riskFilter === 'medium') filtered = filtered.filter(a => a.risk_score >= 40 && a.risk_score < 70);
  else if (riskFilter === 'low') filtered = filtered.filter(a => a.risk_score < 40);

  const container = document.getElementById('alerts-list');
  if (!container) return;

  const sorted = filtered.sort((a, b) => b.risk_score - a.risk_score);

  container.innerHTML = sorted.map(a => {
    const level = a.risk_score >= 70 ? 'high' : a.risk_score >= 40 ? 'medium' : 'low';
    return `
      <div class="alert-card alert-${level}">
        <div class="alert-card-score">${a.risk_score}</div>
        <div class="alert-card-body">
          <div class="alert-card-header">
            <span class="alert-card-rule">${a.rule_triggered}</span>
            <span class="alert-card-user">${a.db_user}</span>
            <span class="alert-card-time">${a.detail?.thoi_diem || ''}</span>
          </div>
          <div class="alert-card-desc">${a.detail?.mo_ta || ''}</div>
          ${a.detail?.cau_lenh ? `<div class="alert-card-stmt">${a.detail.cau_lenh}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (sorted.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>Không tìm thấy cảnh báo nào phù hợp bộ lọc.</p></div>`;
  }
}

// ─── CONSOLE HELPERS ────────────────────────────────────────────────────────
function logToConsole(type, msg) {
  const console_el = document.getElementById('console-output');
  if (!console_el) return;

  if (type === 'separator') {
    const div = document.createElement('div');
    div.className = 'console-separator';
    console_el.appendChild(div);
    return;
  }

  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const div = document.createElement('div');
  div.className = `console-line console-${type}`;
  div.innerHTML = `<span class="console-time">${time}</span><span class="console-msg">${escapeHtml(msg)}</span>`;
  console_el.appendChild(div);
  console_el.scrollTop = console_el.scrollHeight;
}

function clearConsole() {
  const console_el = document.getElementById('console-output');
  if (console_el) {
    console_el.innerHTML = `
      <div class="console-line console-info">
        <span class="console-time">--:--:--</span>
        <span class="console-msg">Console đã được xóa. Nhấn "Chạy phân tích" để bắt đầu.</span>
      </div>
    `;
  }
}

function exportLog() {
  const console_el = document.getElementById('console-output');
  if (!console_el) return;

  const lines = [];
  console_el.querySelectorAll('.console-line').forEach(line => {
    const time = line.querySelector('.console-time')?.textContent || '';
    const msg = line.querySelector('.console-msg')?.textContent || '';
    lines.push(`[${time}] ${msg}`);
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `secdb-analysis-${Date.now()}.log`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── UTILITY ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function redactStatement(stmt) {
  // Mô phỏng redact.js — che chuỗi >= 9 chữ số
  let text = String(stmt || '').replace(/\d{9,}/g, m => `<${m.length}_chu_so_da_che>`);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 300) text = text.slice(0, 300) + '... <cắt bớt>';
  return text;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Show brief feedback — could be a toast
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ─── MOCK DATA GENERATORS ───────────────────────────────────────────────────
// Mô phỏng dữ liệu log thật sự dựa trên cấu trúc của project
// (postgresql-YYYY-MM-DD_HHMMSS.json)

function generateMockAlerts() {
  const users = ['nv_hn01', 'nv_dn01', 'nv_hcm01'];
  const now = new Date();
  const alerts = [];

  // FULL_TABLE_READ alerts
  for (let i = 0; i < 5; i++) {
    const u = users[i % users.length];
    const t = new Date(now - (i * 3600 * 1000));
    const ts = formatTimestamp(t);
    alerts.push({
      db_user: u,
      rule_triggered: 'FULL_TABLE_READ',
      risk_score: 60,
      detail: {
        mo_ta: 'Đọc bảng nhạy cảm app.customers mà không có điều kiện lọc',
        cau_lenh: 'SELECT * FROM app.customers',
        session_id: `6${i}f2a3b.${1000 + i}`,
        thoi_diem: ts,
        bang: ['app.customers'],
      },
    });
  }

  // AFTER_HOURS alerts
  for (let i = 0; i < 4; i++) {
    const u = users[i % users.length];
    const t = new Date(now);
    t.setHours(2 + i, 30, 0);
    const ts = formatTimestamp(t);
    alerts.push({
      db_user: u,
      rule_triggered: 'AFTER_HOURS',
      risk_score: 40,
      detail: {
        mo_ta: `Truy cập dữ liệu ngoài giờ hành chính: ${2 + i}:30 nằm ngoài khung 7h-19h`,
        cau_lenh: `SELECT full_name, phone FROM app.customers WHERE branch_id = ${i + 1}`,
        session_id: `7${i}a1b2c.${2000 + i}`,
        thoi_diem: ts,
        gio: `${2 + i}:30`,
        bang: ['app.customers'],
      },
    });
  }

  // SQLI_UNION alert
  alerts.push({
    db_user: 'nv_dn01',
    rule_triggered: 'SQLI_UNION',
    risk_score: 90,
    detail: {
      mo_ta: 'Câu lệnh chứa UNION SELECT — dấu hiệu khai thác SQL Injection',
      cau_lenh: "SELECT full_name FROM app.customers WHERE full_name = '' UNION SELECT username || ':' || password_hash FROM app.staff --'",
      session_id: '8af3c4d.3001',
      thoi_diem: formatTimestamp(new Date(now - 7200000)),
      bang: ['app.customers', 'app.staff'],
    },
  });

  // STAFF_CREDENTIAL_READ
  alerts.push({
    db_user: 'nv_hcm01',
    rule_triggered: 'STAFF_CREDENTIAL_READ',
    risk_score: 75,
    detail: {
      mo_ta: 'Phiên đã SET ROLE sang nv_hcm01 nhưng vẫn đọc app.staff (bảng chứa password_hash)',
      cau_lenh: 'SELECT username, password_hash FROM app.staff',
      session_id: '9bf4d5e.4001',
      thoi_diem: formatTimestamp(new Date(now - 3600000)),
      bang: ['app.staff'],
    },
  });

  // BULK_DECRYPT
  alerts.push({
    db_user: 'nv_hn01',
    rule_triggered: 'BULK_DECRYPT',
    risk_score: 82,
    detail: {
      mo_ta: 'Một câu lệnh giải mã 120 bản ghi (ngưỡng 50)',
      cau_lenh: 'SELECT app.decrypt_text(cccd) FROM app.customers',
      session_id: 'abf5e6f.5001',
      thoi_diem: formatTimestamp(new Date(now - 1800000)),
      so_ban_ghi_giai_ma: 120,
      bang: ['app.customers'],
    },
  });

  return alerts;
}

function generateMockLogLines() {
  const lines = [];
  const users = ['nv_hn01', 'nv_dn01', 'nv_hcm01'];
  const now = new Date();

  // Generate ~100 mock log lines simulating real pgAudit output
  // Local socket lines (should be skipped by analyzer)
  for (let i = 0; i < 15; i++) {
    const t = new Date(now - (100 - i) * 60000);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'postgres',
      remote_host: '[local]',
      session_id: `local-${i}`,
      pid: 100 + i,
      audit_class: 'DDL',
      command: 'CREATE TABLE',
      object_name: 'app.customers',
      statement: 'CREATE TABLE IF NOT EXISTS app.customers (...)',
      substatement_id: 1,
    });
  }

  // SET ROLE lines
  users.forEach((u, idx) => {
    const t = new Date(now - (80 - idx * 20) * 60000);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'app_user',
      remote_host: '172.28.0.1',
      session_id: `sess-${idx}`,
      pid: 200 + idx,
      audit_class: 'MISC',
      command: 'SET',
      object_name: '',
      statement: `SET LOCAL ROLE ${u}`,
      substatement_id: 1,
    });
  });

  // Normal SELECT with WHERE (should NOT trigger FULL_TABLE_READ)
  for (let i = 0; i < 20; i++) {
    const u = users[i % users.length];
    const t = new Date(now - (60 - i) * 60000);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'app_user',
      remote_host: '172.28.0.1',
      session_id: `sess-${i % 3}`,
      pid: 200 + (i % 3),
      audit_class: 'READ',
      command: 'SELECT',
      object_name: 'app.customers',
      statement: `SELECT full_name, phone FROM app.customers WHERE branch_id = ${(i % 3) + 1}`,
      substatement_id: 1,
    });
  }

  // SELECT without WHERE — triggers FULL_TABLE_READ
  for (let i = 0; i < 5; i++) {
    const t = new Date(now - (40 - i) * 60000);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'app_user',
      remote_host: '172.28.0.1',
      session_id: `sess-${i % 3}`,
      pid: 200 + (i % 3),
      audit_class: 'READ',
      command: 'SELECT',
      object_name: 'app.customers',
      statement: 'SELECT * FROM app.customers',
      substatement_id: 1,
    });
  }

  // After-hours queries (2am-5am)
  for (let i = 0; i < 4; i++) {
    const t = new Date(now);
    t.setHours(2 + i, 30, 0);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'app_user',
      remote_host: '172.28.0.1',
      session_id: `late-sess-${i}`,
      pid: 300 + i,
      audit_class: 'READ',
      command: 'SELECT',
      object_name: 'app.customers',
      statement: `SELECT full_name, phone FROM app.customers WHERE branch_id = ${i + 1}`,
      substatement_id: 1,
    });
  }

  // SQL Injection attempt
  lines.push({
    timestamp: formatTimestamp(new Date(now - 3600000)),
    user: 'app_user',
    remote_host: '172.28.0.1',
    session_id: 'sqli-sess',
    pid: 400,
    audit_class: 'READ',
    command: 'SELECT',
    object_name: 'app.customers',
    statement: "SELECT full_name FROM app.customers WHERE full_name = '' UNION SELECT username || ':' || password_hash FROM app.staff --'",
    substatement_id: 1,
  });

  // Staff credential read after SET ROLE
  lines.push({
    timestamp: formatTimestamp(new Date(now - 1800000)),
    user: 'app_user',
    remote_host: '172.28.0.1',
    session_id: 'sess-2',
    pid: 202,
    audit_class: 'READ',
    command: 'SELECT',
    object_name: 'app.staff',
    statement: 'SELECT username, password_hash FROM app.staff',
    substatement_id: 1,
  });

  // Substatement lines (should be counted but not analyzed as client stmt)
  for (let i = 0; i < 20; i++) {
    const t = new Date(now - (30 - i) * 60000);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'app_user',
      remote_host: '172.28.0.1',
      session_id: `sess-${i % 3}`,
      pid: 200 + (i % 3),
      audit_class: 'READ',
      command: 'SELECT',
      object_name: 'ext.pgp_sym_decrypt',
      statement: 'SELECT ext.pgp_sym_decrypt(cccd, ext.master_key())',
      substatement_id: 2, // nested — inside SECURITY DEFINER function
    });
  }

  // Write operations
  for (let i = 0; i < 10; i++) {
    const t = new Date(now - (20 - i) * 60000);
    lines.push({
      timestamp: formatTimestamp(t),
      user: 'app_user',
      remote_host: '172.28.0.1',
      session_id: `sess-${i % 3}`,
      pid: 200 + (i % 3),
      audit_class: 'WRITE',
      command: 'INSERT',
      object_name: 'app.orders',
      statement: `INSERT INTO app.orders (customer_id, branch_id, order_no, status, total_amount) VALUES ($1, $2, $3, $4, $5)`,
      substatement_id: 1,
    });
  }

  return lines;
}

function formatTimestamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000 +07`;
}
