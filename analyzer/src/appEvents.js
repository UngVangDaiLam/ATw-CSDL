// Su kien bao mat o TANG WEB -> canh bao.
//
// app/src/securityLog.js ghi cac su kien ma log pgAudit khong the hien duoc:
// o tang database, mot lan dang nhap sai trong y het lan dang nhap dung (cung
// cau SELECT tren app.staff), con request CSRF bi chan thi khong toi DB. File
// la JSON Lines trong logs/app/, analyzer doc CHI DOC.
//
// NOI DUNG FILE LA DU LIEU KHONG TIN CAY. App bi chiem thi ke tan cong ghi
// duoc bat cu gi vao day: kiem tra kieu tung truong, cat ngan, che chuoi so dai
// (redact.js) - cung cach doi xu voi cau SQL trong log pgAudit. Ten su kien la
// - danh sach trang; su kien la thi bo qua.
//
// Gioi han can noi trong bao cao: app bi chiem cung co the IM LANG (khong ghi
// gi) hoac ghi su kien gia - mot nguon su kien tu chinh app khong chong duoc
// app da bi chiem. No bo sung cho log pgAudit, khong thay the.

const fs = require('fs');
const path = require('path');
const { redactStatement } = require('./redact');

// db_user cho canh bao tu tang web: chua biet nhan vien nao (dang nhap chua
// thanh cong, hoac request CSRF mang cookie cua NAN NHAN chu khong phai cua ke
// tan cong). Phien bi loi dung - neu co - nam o detail.phien_cua.
const WEB_ACTOR = 'web';

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \+07$/;
const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;

function listAppLogs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().map((n) => path.join(dir, n));
}

function str(v, max) {
  if (v === null || v === undefined) return null;
  return redactStatement(String(v)).slice(0, max);
}

function evaluateAppEvent(r) {
  if (!r || typeof r !== 'object' || !TS_RE.test(String(r.ts))) return [];
  const client = IP_RE.test(String(r.ip)) ? String(r.ip) : null;
  const base = {
    nguon: 'app',
    su_kien: String(r.event).slice(0, 32),
    thoi_diem: r.ts,
    client,
    duong_dan: `${str(r.method, 8) ?? ''} ${str(r.path, 100) ?? ''}`.trim(),
    phien_cua: str(r.staff, 32),
  };

  if (r.event === 'login_locked') {
    const byIp = r.lock_scope === 'ip';
    const user = str(r.username, 64) ?? '';
    const n = Math.max(0, Math.min(Number(r.failures) || 0, 100000));
    const min = Math.max(1, Math.ceil((Number(r.retry_after_s) || 900) / 60));
    return [{
      db_user: WEB_ACTOR,
      rule_triggered: 'LOGIN_BRUTE_FORCE',
      risk_score: byIp ? 90 : 80,
      detail: {
        ...base,
        mo_ta: byIp
          ? `Do mat khau tu ${client}: ${n} lan dang nhap sai tren nhieu tai khoan - khoa moi dang nhap tu IP nay ${min} phut`
          : `Do mat khau tai khoan "${user}" tu ${client}: ${n} lan sai lien tiep - da khoa tam ${min} phut`,
        tai_khoan: user,
        so_lan: n,
        khoa_theo: byIp ? 'ip' : 'tai_khoan',
      },
    }];
  }

  if (r.event === 'csrf_rejected') {
    const form = r.reason === 'content_type';
    const reason = ['content_type', 'token_missing', 'token_mismatch'].includes(r.reason) ? r.reason : 'khac';
    return [{
      db_user: WEB_ACTOR,
      rule_triggered: 'CSRF_BLOCKED',
      // Gui dang form: client that luon gui JSON -> gan nhu chac chan la CSRF.
      // Thieu/sai token: co the chi la token het han -> diem thap hon.
      risk_score: form ? 70 : 50,
      detail: {
        ...base,
        mo_ta: form
          ? `Request ghi du lieu dang form (${str(r.content_type, 60) ?? 'khong ro'}) bi chan - client that luon gui JSON, dau hieu CSRF tu trang khac`
          : `Request ghi du lieu ${reason === 'token_missing' ? 'thieu' : 'sai'} CSRF token bi chan - co the la CSRF, hoac token het han`,
        ly_do: reason,
      },
    }];
  }

  return [];   // su kien khong co trong danh sach -> bo qua
}

module.exports = { listAppLogs, evaluateAppEvent, WEB_ACTOR };
