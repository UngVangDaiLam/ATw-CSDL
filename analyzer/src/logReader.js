const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Doc file jsonlog theo TUNG DONG (stream), khong nap ca file vao bo nho:
// mot lan seed da de lai file 26 MB, va log that cua mot ky demo se lon hon
// nhieu. readline + createReadStream giu bo nho phang du file bao lon.
//
// skipLines: so dong da xu ly o lan chay truoc (doc tu file trang thai), de
// chay lai khong sinh canh bao trung.
//
// DUNG NGAY khi gap dong khong parse duoc: PostgreSQL co the dang ghi do dang
// dong cuoi cung ngay luc analyzer doc toi. Neu bo qua dong do roi doc tiep,
// vi tri da xu ly se vuot qua no va dong do mat vinh vien. Dung lai thi lan
// chay sau doc lai tu dung cho ay, luc do dong da ghi xong.
async function* readJsonLog(filePath, skipLines = 0) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo <= skipLines) continue;
      if (!line.trim()) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch (err) {
        return; // dong viet do dang - de lan sau doc lai
      }

      yield { lineNo, record };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

// Danh sach file jsonlog, sap theo ten. log_filename co dang
// postgresql-%Y-%m-%d_%H%M%S.log nen sap theo ten cung la sap theo thoi gian.
function listJsonLogs(logDir) {
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(logDir, name));
}

module.exports = { readJsonLog, listJsonLogs };
