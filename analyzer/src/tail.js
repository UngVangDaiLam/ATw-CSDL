// Doc TANG DAN mot file jsonlog theo vi tri byte - cho che do watch.
//
// logReader.readJsonLog() bo qua phan da doc bang cach DEM DONG tu dau file.
// Chay mot lan thi khong sao, nhung watch goi no moi 2 giay tren file co the
// toi hang chuc MB (lan seed de lai 26 MB) - quet lai ca file moi nhip. O day
// nho vi tri byte va chi doc phan moi ghi them.
//
// File trang thai van luu SO DONG (dung chung voi batch); vi tri byte chi giu
// trong bo nho va duoc quy doi tu so dong mot lan khi bat dau theo doi file.

const fs = require('fs');

// Moi nhip doc toi da bay nhieu byte: lan dau theo doi co the gap ca dong log
// cu, khong nap mot lan ca file vao bo nho.
const MAX_CHUNK = 8 * 1024 * 1024;
const NL = 0x0a;

// Vi tri byte ngay sau dong thu `lines` (dem tu 1). Quet mot lan, theo khoi.
function byteOffsetOfLine(filePath, lines) {
  if (lines <= 0) return 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    let seen = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) return pos;   // file ngan hon so dong da luu (vd. bi lam lai)
      for (let i = 0; i < n; i += 1) {
        if (buf[i] === NL && ++seen === lines) return pos + i + 1;
      }
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Doc cac dong DA HOAN CHINH tu vi tri `offset`. Phan cuoi file chua co ky tu
// xuong dong la dong PostgreSQL dang ghi do - de nguyen, nhip sau doc lai.
//
// Tra ve { records: [{lineNo, record}], offset, lineNo, truncated, bad }:
//   offset/lineNo: vi tri va so dong moi sau khi doc
//   truncated:     file nho hon offset -> da bi lam lai, goi lai voi offset 0
//   bad:           so dong hoan chinh nhung khong parse duoc (bo qua)
function readNew(filePath, offset, lineNo) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { records: [], offset, lineNo, truncated: false, bad: 0 };
  }
  if (size < offset) return { records: [], offset: 0, lineNo: 0, truncated: true, bad: 0 };
  if (size === offset) return { records: [], offset, lineNo, truncated: false, bad: 0 };

  const want = Math.min(size - offset, MAX_CHUNK);
  const buf = Buffer.allocUnsafe(want);
  const fd = fs.openSync(filePath, 'r');
  let n;
  try {
    n = fs.readSync(fd, buf, 0, want, offset);
  } finally {
    fs.closeSync(fd);
  }

  // Chi lay toi ky tu xuong dong cuoi cung. Cat theo BYTE chu khong theo chuoi:
  // mot ky tu UTF-8 (tieng Viet trong cau SQL) co the nam vat qua ranh gioi khoi.
  const end = buf.lastIndexOf(NL, n - 1);
  if (end < 0) return { records: [], offset, lineNo, truncated: false, bad: 0 };

  const lines = buf.toString('utf8', 0, end + 1).split('\n');
  // Chuoi ket thuc bang '\n' nen split cho them mot phan tu rong o cuoi - bo
  // no di. Moi phan tu con lai la DUNG mot dong, ke ca dong trong: phai dem ca
  // dong trong de so dong khop voi cach readline dem trong logReader (file
  // trang thai dung chung giua hai che do).
  lines.pop();

  const records = [];
  let bad = 0;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      records.push({ lineNo, record: JSON.parse(line) });
    } catch {
      // Khac batch (dung han de doc lai): o day dong da co ky tu xuong dong,
      // tuc la PostgreSQL da ghi xong - parse hong la dong hong that su. Dung
      // lai thi watch ket vinh vien tai cho nay, nen bo qua va dem lai.
      bad += 1;
    }
  }
  return { records, offset: offset + end + 1, lineNo, truncated: false, bad };
}

module.exports = { byteOffsetOfLine, readNew };
