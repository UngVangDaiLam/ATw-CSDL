// Tap rule. Moi rule la mot module co { name, run(stmt, config) } tra ve
// { rule, risk, detail } hoac null.
//
// MOT cau lenh co the kich hoat NHIEU rule cung luc, va do la co y: mot cau
// UNION SELECT doc app.staff luc 2 gio sang sinh ra ba canh bao khac nhau. Ba
// goc nhin doc lap cung chi vao mot hanh vi la bang chung manh hon nhieu so
// voi mot canh bao tong hop mo ho - nguoi doc bao cao nhin ra ngay vi sao no
// bi danh dau.
//
// Them rule moi: tao file trong thu muc nay roi them vao mang duoi day.

module.exports = [
  require('./sqlInjection'),
  require('./staffCredentialRead'),
  require('./bulkDecrypt'),
  require('./fullTableRead'),
  require('./afterHours'),
];
