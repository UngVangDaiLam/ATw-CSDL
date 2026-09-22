// Gom cac dong log roi rac thanh "su kien cau lenh", va quy trach nhiem cho
// dung nhan vien.
//
// ---------------------------------------------------------------------------
// VAN DE 1 - Cot `user` trong log LUON la app_user
//
// App ket noi bang MOT pool duy nhat (app_user) roi "SET LOCAL ROLE nv_xxx"
// cho tung request. `user` trong log la SESSION USER - danh tinh da xac thuc
// luc bat tay - nen SET ROLE khong doi duoc no. Nhin vao log tho thi moi hanh
// dong deu la "app_user", khong quy duoc trach nhiem cho ai.
//
// Cach go: bam theo tung PHIEN. Gap dong class MISC + command SET co chua
// "SET [LOCAL] ROLE nv_dn01" thi moi cau lenh sau do TRONG CUNG PHIEN duoc tinh
// cho nv_dn01, cho toi dong SET ROLE ke tiep hoac khi phien dong.
//
// Day cung la ly do pgaudit.log PHAI co class `misc_set` (xem postgresql.conf):
// class `role` chi bat GRANT/REVOKE/CREATE ROLE, khong bat SET ROLE.
//
// DUNG session_id LAM KHOA, KHONG DUNG pid:
// pid duoc he dieu hanh cap phat lai sau khi tien trinh backend ket thuc. Hai
// phien khac nhau cach nhau vai phut hoan toan co the mang cung mot pid, va khi
// do danh tinh cua phien truoc se "ri" sang phien sau - dung kieu loi ma lop
// RLS da cat cong phu de tranh (xem app/src/middleware/setRole.js). Truong
// session_id cua PostgreSQL la <hex thoi diem mo phien>.<hex pid> nen duy nhat
// theo thoi gian. pid van duoc giu lai trong detail de doi chieu voi log tho.
//
// ---------------------------------------------------------------------------
// VAN DE 2 - Mot cau lenh sinh ra RAT NHIEU dong log
//
// a) pgaudit.log_relation = on: cau lenh dung cham 2 bang thi co 2 dong AUDIT
//    cung stmt_id. Phai gop lai, neu khong se dem trung.
//
// b) Quan trong hon: cac ham SECURITY DEFINER viet bang SQL (app.encrypt_text,
//    app.decrypt_text, app.blind_index) co than la mot cau SELECT, va pgAudit
//    ghi lai TUNG LOI GOI nhu mot cau lenh long nhau. Lan seed 6000 khach hang
//    de lai 47.017 dong READ,SELECT trong log - gan nhu toan bo la than ham.
//    Neu khong loc, moi rule deu chim trong nhieu nay.
//
//    Phan biet bang truong substatement_id: == 1 la cau lenh CLIENT gui len,
//    > 1 la cau long nhau ben trong. Cac dong long nhau khong bi vut di ma
//    duoc DEM: so lan goi pgp_sym_decrypt trong mot cau lenh chinh la so ban
//    ghi da bi giai ma - chinh xac thu ma rule BULK_DECRYPT can.
// ---------------------------------------------------------------------------

const { parseAuditMessage, extractRoleChange } = require('./auditLine');

const DECRYPT_RE = /pgp_sym_decrypt/i;
const ENCRYPT_RE = /pgp_sym_encrypt/i;

class SessionTracker {
  // onStatement: callback nhan tung su kien cau lenh da gom xong.
  constructor(onStatement) {
    this.sessions = new Map();
    this.onStatement = onStatement;
  }

  feed(record) {
    const sessionId = record.session_id || `pid-${record.pid}`;
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        pid: record.pid,
        sessionUser: null,
        database: null,
        remoteHost: null,
        appName: null,
        role: null,        // vai hien tai do SET ROLE dat ra
        pending: null,     // nhom cau lenh dang gom do
      };
      this.sessions.set(sessionId, session);
    }

    // Bo sung dan thong tin phien khi chung xuat hien.
    // KHONG lay mot lan o dong dau tien: dong dau cua moi phien la
    // "connection received: host=..." - luc do chua xac thuc xong nen ban ghi
    // CHUA co truong `user`. Neu chi doc mot lan thi session user se la
    // undefined suot ca phien, va moi canh bao sinh ra deu mat danh tinh.
    if (record.user) session.sessionUser = record.user;
    if (record.dbname) session.database = record.dbname;
    if (record.remote_host) session.remoteHost = record.remote_host;
    if (record.application_name) session.appName = record.application_name;

    const message = record.message || '';

    // Phien dong -> xa not cau lenh cuoi roi quen phien di, tranh phinh bo nho
    // khi doc file log lon.
    if (message.startsWith('disconnection:')) {
      this.flushSession(session);
      this.sessions.delete(sessionId);
      return;
    }

    const audit = parseAuditMessage(message);
    if (!audit) return;

    // stmt_id doi -> cau lenh truoc da xong.
    if (!session.pending || session.pending.statementId !== audit.statementId) {
      this.flushSession(session);
      session.pending = {
        statementId: audit.statementId,
        // Vai TAI THOI DIEM cau lenh bat dau. Lay truoc khi xu ly dong nay de
        // chinh cau "SET ROLE nv_x" van duoc quy cho vai cu (app_user), con
        // cac cau sau moi thuoc ve nv_x.
        role: session.role,
        relations: new Set(),
        decryptedRows: 0,
        encryptedRows: 0,
        head: null,
        timestamp: record.timestamp,
      };
    }

    const pending = session.pending;

    if (audit.substatementId === 1) {
      if (!pending.head) {
        pending.head = {
          class: audit.class,
          command: audit.command,
          statement: audit.statement,
        };
      }
      if (audit.objectName) pending.relations.add(audit.objectName);

      // Chi xet doi vai tren dong da duoc loc theo class - khong tim chuoi
      // "SET ROLE" trong moi cau lenh (xem auditLine.js).
      if (audit.class === 'MISC' && audit.command === 'SET') {
        const change = extractRoleChange(audit.statement);
        if (change !== undefined) session.role = change;
      }
    } else {
      // Cau long nhau: khong phai hanh dong client, nhung dem duoc.
      if (DECRYPT_RE.test(audit.statement)) pending.decryptedRows += 1;
      else if (ENCRYPT_RE.test(audit.statement)) pending.encryptedRows += 1;
    }
  }

  flushSession(session) {
    const pending = session.pending;
    session.pending = null;
    if (!pending || !pending.head) return;

    this.onStatement({
      sessionId: session.sessionId,
      pid: session.pid,
      sessionUser: session.sessionUser,
      database: session.database,
      remoteHost: session.remoteHost,
      appName: session.appName,
      // Ai chiu trach nhiem: vai da SET ROLE, khong co thi la chinh session user.
      actor: pending.role || session.sessionUser,
      roleWasSet: Boolean(pending.role),
      timestamp: pending.timestamp,
      statementId: pending.statementId,
      class: pending.head.class,
      command: pending.head.command,
      statement: pending.head.statement || '',
      relations: Array.from(pending.relations),
      decryptedRows: pending.decryptedRows,
      encryptedRows: pending.encryptedRows,
    });
  }

  // Goi khi het file: cac phien chua thay dong disconnection van con cau lenh
  // dang gom do.
  flushAll() {
    for (const session of this.sessions.values()) this.flushSession(session);
  }
}

module.exports = SessionTracker;
