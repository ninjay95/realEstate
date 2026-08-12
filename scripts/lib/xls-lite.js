// Minimal read-only reader for legacy .xls workbooks (OLE2 container, BIFF8
// records) — no npm dependencies, matching scripts/lib/xlsx-lite.js for the
// modern format.
//
// Victoria publishes the Property Sales Report only as legacy .xls, so this
// exists to read it. It handles what a plain data table needs: the shared
// string table (including strings split across CONTINUE records), label,
// number, RK and MULRK cells, and cached formula results. Formatting, dates as
// dates, merged cells and charts are all ignored.

const fs = require("fs");

/* --- OLE2 compound file ---------------------------------------------------
 * The file is a little FAT filesystem: a header, a sector allocation table,
 * and a directory of streams. We only need to pull out the "Workbook" stream.
 */
function readOle(buf) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error("not an OLE2 file");
  }
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSectorSize = 1 << buf.readUInt16LE(32);
  const dirStart = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  const difatStart = buf.readUInt32LE(68);
  const difatCount = buf.readUInt32LE(72);

  const sectorOffset = (n) => 512 + n * sectorSize;
  const readSector = (n) => buf.subarray(sectorOffset(n), sectorOffset(n) + sectorSize);

  // DIFAT -> list of FAT sectors (first 109 inline, rest chained)
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s === 0xffffffff) break;
    fatSectors.push(s);
  }
  let next = difatStart;
  for (let n = 0; n < difatCount && next !== 0xffffffff && next !== 0xfffffffe; n++) {
    const sec = readSector(next);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const s = sec.readUInt32LE(i * 4);
      if (s !== 0xffffffff) fatSectors.push(s);
    }
    next = sec.readUInt32LE(sectorSize - 4);
  }

  const fat = [];
  for (const s of fatSectors) {
    const sec = readSector(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sec.readUInt32LE(i * 4));
  }

  const chain = (start, table) => {
    const out = [];
    let s = start;
    const guard = table.length + 8;
    while (s !== 0xfffffffe && s !== 0xffffffff && out.length < guard) {
      out.push(s);
      s = table[s];
      if (s === undefined) break;
    }
    return out;
  };

  const readChain = (start, size) => {
    const parts = chain(start, fat).map(readSector);
    const all = Buffer.concat(parts);
    return size != null ? all.subarray(0, size) : all;
  };

  // directory entries (128 bytes each)
  const dirBuf = readChain(dirStart);
  const entries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameLen = dirBuf.readUInt16LE(off + 64);
    if (nameLen <= 0) continue;
    const name = dirBuf.subarray(off, off + Math.max(0, nameLen - 2)).toString("utf16le");
    entries.push({
      name,
      type: dirBuf.readUInt8(off + 66),
      start: dirBuf.readUInt32LE(off + 116),
      size: dirBuf.readUInt32LE(off + 120),
    });
  }

  // mini stream lives inside the root entry's stream
  const root = entries.find((e) => e.type === 5);
  const miniFat = [];
  if (miniFatStart !== 0xfffffffe) {
    const mf = readChain(miniFatStart);
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readUInt32LE(i * 4));
  }
  const miniStream = root && root.size > 0 ? readChain(root.start, root.size) : Buffer.alloc(0);

  const readStream = (entry) => {
    if (entry.size < miniCutoff) {
      const parts = chain(entry.start, miniFat).map((s) =>
        miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize)
      );
      return Buffer.concat(parts).subarray(0, entry.size);
    }
    return readChain(entry.start, entry.size);
  };

  return { entries, readStream };
}

/* --- BIFF8 ---------------------------------------------------------------- */

const REC = {
  BOF: 0x0809, EOF: 0x000a, BOUNDSHEET: 0x0085, SST: 0x00fc, CONTINUE: 0x003c,
  LABELSST: 0x00fd, LABEL: 0x0204, NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd,
  FORMULA: 0x0006, STRING: 0x0207, BLANK: 0x0201, MULBLANK: 0x00be,
};

function decodeRk(v) {
  const isInt = v & 0x02;
  const div100 = v & 0x01;
  let num;
  if (isInt) {
    num = (v | 0) >> 2; // signed shift sign-extends the 30-bit integer
  } else {
    const b = Buffer.alloc(8);
    b.writeInt32LE(0, 0);
    b.writeInt32LE(v & 0xfffffffc, 4);
    num = b.readDoubleLE(0);
  }
  return div100 ? num / 100 : num;
}

// Reads the shared string table across SST + CONTINUE blocks. A string's
// character data can straddle a block boundary, and the continuation restates
// its own 8/16-bit flag, which is the whole reason this needs a cursor.
function parseSst(blocks) {
  let bi = 0, pos = 0;
  const atEnd = () => bi >= blocks.length;
  const remaining = () => (atEnd() ? 0 : blocks[bi].length - pos);
  const ensure = (n) => {
    while (!atEnd() && remaining() < n) { bi++; pos = 0; }
  };
  const u8 = () => { ensure(1); const v = blocks[bi].readUInt8(pos); pos += 1; return v; };
  const u16 = () => { ensure(2); const v = blocks[bi].readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { ensure(4); const v = blocks[bi].readUInt32LE(pos); pos += 4; return v; };
  const skip = (n) => {
    let left = n;
    while (left > 0 && !atEnd()) {
      const take = Math.min(left, remaining());
      pos += take; left -= take;
      if (remaining() === 0) { bi++; pos = 0; }
    }
  };

  u32(); // total refs
  const unique = u32();
  const strings = [];
  for (let i = 0; i < unique && !atEnd(); i++) {
    let cch = u16();
    let grbit = u8();
    let high = grbit & 0x01;
    const rich = grbit & 0x08;
    const ext = grbit & 0x04;
    const runs = rich ? u16() : 0;
    const extSize = ext ? u32() : 0;

    let out = "";
    let left = cch;
    while (left > 0 && !atEnd()) {
      if (remaining() === 0) { bi++; pos = 0; if (atEnd()) break; }
      const charBytes = high ? 2 : 1;
      const canRead = Math.floor(remaining() / charBytes);
      const take = Math.min(left, canRead);
      if (take > 0) {
        const slice = blocks[bi].subarray(pos, pos + take * charBytes);
        out += high ? slice.toString("utf16le") : slice.toString("latin1");
        pos += take * charBytes;
        left -= take;
      }
      if (left > 0) {
        // crossed into a CONTINUE: it restates the encoding flag
        bi++; pos = 0;
        if (atEnd()) break;
        high = blocks[bi].readUInt8(pos) & 0x01;
        pos += 1;
      }
    }
    if (runs) skip(runs * 4);
    if (extSize) skip(extSize);
    strings.push(out);
  }
  return strings;
}

function readWorkbook(filePath) {
  const buf = fs.readFileSync(filePath);
  const { entries, readStream } = readOle(buf);
  const wbEntry = entries.find((e) => e.type === 2 && /^(Workbook|Book)$/i.test(e.name));
  if (!wbEntry) throw new Error("no Workbook stream");
  const wb = readStream(wbEntry);

  // pass 1: records, shared strings, sheet directory
  const records = [];
  for (let off = 0; off + 4 <= wb.length; ) {
    const type = wb.readUInt16LE(off);
    const len = wb.readUInt16LE(off + 2);
    const data = wb.subarray(off + 4, off + 4 + len);
    records.push({ type, data, off });
    off += 4 + len;
  }

  let sst = [];
  const sheets = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type === REC.SST) {
      const blocks = [r.data];
      for (let j = i + 1; j < records.length && records[j].type === REC.CONTINUE; j++) blocks.push(records[j].data);
      sst = parseSst(blocks);
    } else if (r.type === REC.BOUNDSHEET) {
      const startPos = r.data.readUInt32LE(0);
      const cch = r.data.readUInt8(6);
      const flags = r.data.readUInt8(7);
      const name = flags & 0x01
        ? r.data.subarray(8, 8 + cch * 2).toString("utf16le")
        : r.data.subarray(8, 8 + cch).toString("latin1");
      sheets.push({ name, startPos, rows: [] });
    }
  }

  // pass 2: cells, per sheet substream (located by BOUNDSHEET stream offsets)
  const bofOffsets = records.filter((r) => r.type === REC.BOF).map((r) => r.off);
  for (const sheet of sheets) {
    const startIdx = records.findIndex((r) => r.off === sheet.startPos);
    if (startIdx < 0) continue;
    const put = (row, col, value) => {
      if (!sheet.rows[row]) sheet.rows[row] = [];
      sheet.rows[row][col] = value;
    };
    for (let i = startIdx + 1; i < records.length; i++) {
      const r = records[i];
      if (r.type === REC.BOF && bofOffsets.includes(r.off) && r.off !== sheet.startPos) break;
      if (r.type === REC.EOF) break;
      const d = r.data;
      switch (r.type) {
        case REC.LABELSST:
          put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? "");
          break;
        case REC.LABEL: {
          const cch = d.readUInt16LE(6);
          const flags = d.readUInt8(8);
          put(d.readUInt16LE(0), d.readUInt16LE(2),
            flags & 0x01 ? d.subarray(9, 9 + cch * 2).toString("utf16le") : d.subarray(9, 9 + cch).toString("latin1"));
          break;
        }
        case REC.NUMBER:
          put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
          break;
        case REC.RK:
          put(d.readUInt16LE(0), d.readUInt16LE(2), decodeRk(d.readUInt32LE(6)));
          break;
        case REC.MULRK: {
          const row = d.readUInt16LE(0);
          const first = d.readUInt16LE(2);
          const count = (d.length - 6) / 6;
          for (let k = 0; k < count; k++) put(row, first + k, decodeRk(d.readUInt32LE(4 + k * 6 + 2)));
          break;
        }
        case REC.FORMULA: {
          // cached result: a real double unless the top word is 0xFFFF, which
          // flags a string/bool/error carried by the record that follows
          if (d.readUInt16LE(12) === 0xffff) {
            const kind = d.readUInt8(6);
            if (kind === 0 && records[i + 1] && records[i + 1].type === REC.STRING) {
              const s = records[i + 1].data;
              const cch = s.readUInt16LE(0);
              const flags = s.readUInt8(2);
              put(d.readUInt16LE(0), d.readUInt16LE(2),
                flags & 0x01 ? s.subarray(3, 3 + cch * 2).toString("utf16le") : s.subarray(3, 3 + cch).toString("latin1"));
            }
          } else {
            put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return { sheets };
}

module.exports = { readWorkbook };
