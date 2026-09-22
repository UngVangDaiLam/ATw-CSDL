const { Client } = require('pg');

// Ghi canh bao vao audit.alerts bang role analyzer_user.
//
// Role nay CHI co INSERT tren dung mot bang (postgres/init/04_grants.sql).
// Hai he qua phai nho khi sua file nay:
//
//   1. KHONG duoc dung "RETURNING id" - RETURNING doc gia tri cot nen doi hoi
//      quyen SELECT tren cot do, ma analyzer_user khong co. Muon xac nhan da
//      ghi thi RETURNING mot hang so (khong tham chieu cot nao) nhu
//      scripts/verify.sh dang lam.
//   2. KHONG the truy van bang de loc canh bao trung. Do la ly do analyzer tu
//      ghi nho vi tri da doc bang file trang thai ben ngoai, chu khong hoi lai
//      database. Doi lai duoc tinh chat quan trong hon: bang canh bao la
//      append-only ke ca doi voi chinh tien trinh sinh ra no.
class AlertWriter {
  constructor(dbConfig, { dryRun = false } = {}) {
    this.dbConfig = dbConfig;
    this.dryRun = dryRun;
    this.client = null;
    this.written = 0;
  }

  async connect() {
    if (this.dryRun) return;
    this.client = new Client(this.dbConfig);
    await this.client.connect();
  }

  async writeAll(alerts) {
    if (this.dryRun || alerts.length === 0) return;

    // Mot transaction cho ca lo: hoac ghi duoc het, hoac khong dong nao - tranh
    // truong hop dut giua chung lam file trang thai va bang canh bao lech nhau.
    await this.client.query('BEGIN');
    try {
      for (const a of alerts) {
        await this.client.query(
          `INSERT INTO audit.alerts (db_user, rule_triggered, risk_score, detail)
           VALUES ($1, $2, $3, $4)`,
          [a.db_user, a.rule_triggered, a.risk_score, JSON.stringify(a.detail)]
        );
        this.written += 1;
      }
      await this.client.query('COMMIT');
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async close() {
    if (this.client) await this.client.end();
  }
}

module.exports = AlertWriter;
