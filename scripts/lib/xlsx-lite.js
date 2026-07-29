// Minimal read-only XLSX reader — no npm dependencies.
// An .xlsx file is a ZIP of XML parts; we read the central directory, inflate
// the parts we need (sharedStrings + a worksheet) and pull out cell values.
//
// Only what this project needs: rows of strings/numbers from one sheet.
// Formulas, dates-as-dates, styles and merged cells are ignored — a cell's
// raw value is returned as a string (Excel date serials stay numeric).

const fs = require("fs");
const zlib = require("zlib");

function readZipEntries(buf) {
  // End of Central Directory record: signature 0x06054b50, scan from the end
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no EOCD)");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // central file header
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf, entry) {
  const { localOffset, method, compSize } = entry;
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad local header");
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + compSize);
  return method === 0 ? raw : zlib.inflateRawSync(raw);
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");

// Returns { sheetNames, rows } — rows is an array of arrays of strings/nulls.
function readSheet(filePath, sheetIndex = 0) {
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);

  const sharedEntry = entries.get("xl/sharedStrings.xml");
  const strings = [];
  if (sharedEntry) {
    const xml = inflateEntry(buf, sharedEntry).toString("utf8");
    for (const m of xml.matchAll(/<si>(.*?)<\/si>/gs)) {
      strings.push(unescapeXml([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join("")));
    }
  }

  const wbXml = inflateEntry(buf, entries.get("xl/workbook.xml")).toString("utf8");
  const sheetNames = [...wbXml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => unescapeXml(m[1]));

  // worksheets are named sheet1.xml, sheet2.xml, ... in document order
  const sheetPath = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
  const sheetEntry = entries.get(sheetPath);
  if (!sheetEntry) throw new Error(`no ${sheetPath} in ${filePath}`);
  const xml = inflateEntry(buf, sheetEntry).toString("utf8");

  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*)\/?>(.*?)<\/c>|<c\b([^>]*)\/>/gs)) {
      const attrs = cm[1] ?? cm[3] ?? "";
      const inner = cm[2] ?? "";
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const v = (inner.match(/<v>(.*?)<\/v>/s) || [])[1];
      if (type === "s") cells.push(v === undefined ? null : strings[Number(v)]);
      else if (type === "inlineStr") cells.push(unescapeXml((inner.match(/<t[^>]*>(.*?)<\/t>/s) || [])[1] ?? ""));
      else cells.push(v === undefined ? null : unescapeXml(v));
    }
    rows.push(cells);
  }
  return { sheetNames, rows };
}

// Excel serial date -> "YYYY-MM"
function serialToMonth(serial) {
  const ms = (Number(serial) - 25569) * 86400000; // 1970-01-01 = serial 25569
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

module.exports = { readSheet, serialToMonth };
