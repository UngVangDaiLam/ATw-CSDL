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
//
//    Tuong tu, dong long nhau chua dau moc day bay (config.honeytokenMarker -
//    than ham audit.honeytoken_tripped) nghia la app.decrypt_text() vua giai
//    ma trung MOT ban ghi moi (05_crypto.sql). Chi xet dong LONG NHAU: than
//    ham do db_owner viet. Ke tan cong viet dau moc vao cau SQL cua minh thi no
//    nam o substatement 1, khong duoc dem.
//
//    KHONG dua vao object_name cho viec nay: pgAudit tu giau cau long nhau co
//    cham bang ben trong ham SECURITY DEFINER khi session user (app_user)
//    khong phai thanh vien cua chu ham - dau moc phai nam o cau KHONG cham bang
//    moi con hien trong log (xem BAY 1 o 05_crypto.sql).
// ---------------------------------------------------------------------------

const { parseAuditMessage, extractRoleChange } = require('./auditLine');
const config = require('./config');

// ---------------------------------------------------------------------------
// VAN DE 3 - Vai da SET ROLE chua chac la nguoi do
//
// app_user la thanh vien cua moi role nv_*, nen "SET ROLE nv_dn01" trong log
// KHONG chung minh nv_dn01 dang lam viec. RLS (postgres/init/06_rls.sql) doi
// them token phien dang nhap cua chinh nv_dn01; thieu thi
// app.current_branch_id() ghi mot dong LOG
// "SECDB_IDENTITY_WITHOUT_SESSION role=<current_user> ly_do=...".
//
// Gap dong do voi ly do MAO DANH (IMPERSONATION_REASONS) thi vai cua phien la
// VAI MAO DANH: canh bao cua cac cau lenh trong khoang vai do quy cho session
// user (app_user - danh tinh da xac thuc that), khong quy cho nv_dn01 - nhan
// vien bi mao danh khong lam gi ca. Ten vai van nam trong detail. Token het han
// hay nhan vien bi khoa thi KHONG: nguoi dung van rat co the la chinh nhan vien
// do, canh bao van quy cho ho.
//
// Ba dieu kien de tin mot dong LOG nhu vay:
//   1. context bat dau bang "PL/pgSQL function current_branch_id() " - mot
//      khoi DO tu RAISE LOG cung noi dung mang context "inline_code_block".
//      Ham trung ten trong pg_temp khong tao duoc: PUBLIC khong co quyen TEMP
//      (04_grants.sql).
//   2. role trong dong LOG == vai ma analyzer dang thay phien do mang. Ham do
//      lay current_user nen hai gia tri luon khop; lech nhau nghia la dong LOG
//      khong noi ve vai nay - bo qua, KHONG duoc dung no doi nguoi chiu trach
//      nhiem. (Truoc day ham ghi LOG nhan ten role qua tham so - ai cung goi
//      duoc voi ten bat ky va day trach nhiem cua chinh minh sang app_user.)
//   3. Chi app.current_branch_id() ghi dong nay, khong ham nao nhan ten role
//      tu ben ngoai (06_rls.sql).
// ---------------------------------------------------------------------------
const IDENTITY_PREFIX = 'SECDB_IDENTITY_WITHOUT_SESSION ';
const IDENTITY_RE = /^SECDB_IDENTITY_WITHOUT_SESSION role=([a-z][a-z0-9_]*) ly_do=([a-z_]+)$/;
const IDENTITY_CONTEXT = 'PL/pgSQL function current_branch_id() ';
const IMPERSONATION_REASONS = new Set(['khong_co_token', 'token_khong_ton_tai', 'token_cua_nguoi_khac']);

const DECRYPT_RE = /pgp_sym_decrypt/i;
const ENCRYPT_RE = /pgp_sym_encrypt/i;

class SessionTracker {
  // onStatement: callback nhan tung su kien cau lenh da gom xong.
  constructor(onStatement) {
    this.sessions = new Map();
    this.onStatement = onStatement;
    // Nhip doc hien tai - chi che do watch dung (xem flushIdle). Batch khong
    // dong toi, van flushAll() o cuoi moi file nhu truoc.
    this.tick = 0;
  }

  // pos (tuy chon, chi watch truyen): { file, line } cua dong nay, de biet cau
  // lenh dang gom do bat dau tu dau - xem earliestPendingLine().
  feed(record, pos) {
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
        unverifiedRole: null, // vai bi phat hien dang mang ma khong co phien (VAN DE 3)
        pending: null,     // nhom cau lenh dang gom do
      };
      this.sessions.set(sessionId, session);
    }
    session.lastTick = this.tick;

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

    // Mang vai nhan vien ma khong co token phien (VAN DE 3). Dong nay sinh ra
    // TRONG LUC cau lenh chay, sau cac dong AUDIT cua no, nen gan vao cau dang
    // gom - khong flush, khong tach cau lenh lam doi.
    if (record.error_severity === 'LOG' && message.startsWith(IDENTITY_PREFIX)) {
      const m = IDENTITY_RE.exec(message);
      if (!m || !String(record.context || '').startsWith(IDENTITY_CONTEXT)) return;
      if (m[1] !== session.role) return;     // dieu kien 2, xem VAN DE 3
      const identity = { role: m[1], reason: m[2] };
      if (IMPERSONATION_REASONS.has(m[2])) session.unverifiedRole = m[1];
      if (session.pending) {
        if (!session.pending.identity) session.pending.identity = identity;
      } else {
        const unverified = this.isUnverified(session, session.role);
        this.onStatement({
          ...this.baseEvent(session, record.timestamp),
          actor: unverified ? session.sessionUser : session.role,
          unverifiedRole: unverified ? session.role : null,
          class: 'IDENTITY',
          command: '',
          statement: '',
          relations: [],
          identity,
        });
      }
      return;
    }

    // Phien dong -> xa not cau lenh cuoi roi quen phien di, tranh phinh bo nho
    // khi doc file log lon.
    if (message.startsWith('disconnection:')) {
      this.flushSession(session);
      this.sessions.delete(sessionId);
      return;
    }

    // Cau lenh bi TU CHOI QUYEN (SQLSTATE 42501). pgAudit KHONG ghi dong AUDIT
    // nao cho no: PostgreSQL kiem tra quyen truoc khi goi hook cua pgAudit, nen
    // trong log chi co mot dong ERROR kem nguyen van cau lenh. Bo qua dong nay
    // thi moi cuoc tan cong bi lop 1 chan deu VO HINH voi lop 3 - vi du SQLi
    // UNION doc app.staff.password_hash (04_grants.sql chan o muc cot). Vai van
    // lay tu phien nhu moi cau lenh khac, nen quy duoc cho dung nv_xxx.
    if (record.error_severity === 'ERROR' && record.state_code === '42501') {
      this.flushSession(session);
      const unverified = this.isUnverified(session, session.role);
      this.onStatement({
        ...this.baseEvent(session, record.timestamp),
        actor: unverified ? session.sessionUser : (session.role || session.sessionUser),
        unverifiedRole: unverified ? session.role : null,
        roleWasSet: Boolean(session.role),
        statementId: null,
        class: 'DENIED',
        command: record.ps || '',
        statement: record.statement || '',
        relations: [],
        deniedMessage: record.message || '',
      });
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
        identity: null,
        relations: new Set(),
        decryptedRows: 0,
        encryptedRows: 0,
        honeytokenHits: 0,
        head: null,
        timestamp: record.timestamp,
        startFile: pos?.file,
        startLine: pos?.line,
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
      //
      // pgAudit ghi "RESET ROLE" la MISC,RESET chu KHONG phai MISC,SET. Bo sot
      // no thi vai cu bam mai vao phien: app/ dung SET LOCAL ROLE (het hieu
      // luc o COMMIT, ma COMMIT khong vao log), connection pool tai su dung
      // ket noi, va cau dang nhap ke tiep tren ket noi do - doc app.staff khong
      // SET ROLE - bi quy cho nhan vien cua request truoc thanh canh bao
      // STAFF_CREDENTIAL_READ gia. app/src/middleware/setRole.js vi vay goi
      // RESET ROLE sau moi COMMIT/ROLLBACK de de lai dau moc trong log.
      if (audit.class === 'MISC' && (audit.command === 'SET' || audit.command === 'RESET')) {
        const change = extractRoleChange(audit.statement);
        if (change !== undefined) {
          session.role = change;
          // Doi vai la bat dau mot khoang moi - phai chung minh lai.
          session.unverifiedRole = null;
        }
      }
    } else {
      // Cau long nhau: khong phai hanh dong client, nhung dem duoc.
      if (DECRYPT_RE.test(audit.statement)) pending.decryptedRows += 1;
      else if (ENCRYPT_RE.test(audit.statement)) pending.encryptedRows += 1;
      if (audit.statement.includes(config.honeytokenMarker)) pending.honeytokenHits += 1;
    }
  }

  flushSession(session) {
    const pending = session.pending;
    session.pending = null;
    if (!pending || !pending.head) return;

    // Ai chiu trach nhiem: vai da SET ROLE, khong co thi la chinh session user.
    // Ngoai le: vai mao danh (VAN DE 3) -> session user, ten vai vao detail.
    const unverified = this.isUnverified(session, pending.role);
    this.onStatement({
      ...this.baseEvent(session, pending.timestamp),
      actor: unverified ? session.sessionUser : (pending.role || session.sessionUser),
      unverifiedRole: unverified ? pending.role : null,
      identity: pending.identity,
      roleWasSet: Boolean(pending.role),
      statementId: pending.statementId,
      class: pending.head.class,
      command: pending.head.command,
      statement: pending.head.statement || '',
      relations: Array.from(pending.relations),
      decryptedRows: pending.decryptedRows,
      encryptedRows: pending.encryptedRows,
      honeytokenHits: pending.honeytokenHits,
    });
  }

  // Vai `role` cua phien da bi chung minh la vai mao danh (VAN DE 3). Mot nguon
  // duy nhat: session.unverifiedRole, xoa moi lan doi vai.
  isUnverified(session, role) {
    return Boolean(role) && role === session.unverifiedRole;
  }

  baseEvent(session, timestamp) {
    return {
      sessionId: session.sessionId,
      pid: session.pid,
      sessionUser: session.sessionUser,
      database: session.database,
      remoteHost: session.remoteHost,
      appName: session.appName,
      timestamp,
      decryptedRows: 0,
      encryptedRows: 0,
      honeytokenHits: 0,
    };
  }

  // Goi khi het file: cac phien chua thay dong disconnection van con cau lenh
  // dang gom do.
  flushAll() {
    for (const session of this.sessions.values()) this.flushSession(session);
  }

  // CHE DO WATCH. Mot cau lenh chi biet la "xong" khi phien do sang cau lenh
  // ke tiep hoac dong lai - nhung phien cua connection pool co the ngoi im rat
  // lau sau cau cuoi. Doi den luc do thi canh bao tre vo han.
  //
  // Cac dong cua cung mot cau lenh duoc PostgreSQL ghi ra gan nhu cung luc (ke
  // ca hang nghin dong long nhau cua mot lan giai ma hang loat - phien do lien
  // tuc co dong moi nen khong bi day ra giua chung). Vi vay phien nao KHONG co
  // dong moi nao trong ca mot nhip doc thi cau dang gom coi nhu da xong.
  //
  // KHONG flushAll() moi nhip nhu batch: cat ngang mot cau lenh dang ghi do
  // se tach no lam hai - dem trung bang, hoac chia doi so ban ghi bi giai ma
  // va BULK_DECRYPT bo sot.
  flushIdle() {
    for (const session of this.sessions.values()) {
      if (session.pending && session.lastTick < this.tick) this.flushSession(session);
    }
  }

  // Dong nho nhat (trong file `file`) ma mot cau lenh chua gom xong bat dau.
  // Watch chi duoc luu vi tri da doc toi TRUOC dong nay: luu qua no ma tien
  // trinh bi dung thi cau lenh do mat han, vi lan sau doc tiep tu sau no.
  earliestPendingLine(file) {
    let min = null;
    for (const session of this.sessions.values()) {
      const p = session.pending;
      if (p && p.startFile === file && p.startLine != null && (min === null || p.startLine < min)) {
        min = p.startLine;
      }
    }
    return min;
  }
}

module.exports = SessionTracker;
