// Builds site/data/melbourne/market.json from the Victorian Property Sales
// Report (run scripts/fetch-melbourne-data.js first).
//
// Victoria publishes median sale prices per suburb already split into houses
// and units, one legacy .xls per quarter, each carrying five quarters. The
// published releases overlap, so merging them yields a continuous quarterly
// series per suburb and class.
//
// Trend: the latest quarter against the same quarter a year earlier, expressed
// as %/month. The report flags quarters with fewer than ten sales ("^") and
// quarters carried forward because nothing sold ("*"); both ends of the
// comparison must be unflagged for a trend to be published.
//
// Usage: node scripts/build-market-melbourne.js

const fs = require("fs");
const path = require("path");
const { readWorkbook } = require("./lib/xls-lite");

const SALES_DIR = path.join(__dirname, "raw-melbourne", "sales");
const GEO_PATH = path.join(__dirname, "..", "site", "data", "melbourne", "suburbs.geojson");
const OUT_PATH = path.join(__dirname, "..", "site", "data", "melbourne", "market.json");

const MAX_MONTHLY_MOVE = 4; // over a 12-month window, beyond this is noise

// The report's layout drifts between releases: quarter labels appear as
// "Oct-Dec", "Jul - Sep" or "Oct-Dec\n2023"; the year sits in the same cell or
// a row below; some releases put a flag column beside each median and some
// don't. So columns are found by pattern and then CONFIRMED against the data —
// a real median column is full of six-figure numbers, which is what separates
// it from the sales-count and percentage-change columns that carry the same
// quarter names in their headers.
const QUARTER_RE = /(Jan|Apr|Jul|Oct)\s*[-–]\s*(Mar|Jun|Sep|Dec)/i;
const QUARTER_END = { jan: "03", apr: "06", jul: "09", oct: "12" };
const HEADER_SCAN_ROWS = 6;
const MIN_PLAUSIBLE_PRICE = 20000;

function findQuarterColumns(rows, isDataRow) {
  const candidates = new Map(); // col -> "YYYY-MM"
  const salesCols = [];
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, rows.length); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] !== "string") continue;
      const text = row[c].replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (/sales/i.test(text)) { salesCols.push(c); continue; }
      if (/%|\bto\b|change/i.test(text)) continue; // percentage-change headers
      const m = text.match(QUARTER_RE);
      if (!m) continue;
      let year = (text.match(/\b(?:19|20)\d{2}\b/) || [])[0];
      if (!year) {
        for (let rr = r + 1; rr < Math.min(r + 4, rows.length); rr++) {
          const below = String((rows[rr] || [])[c] ?? "");
          const y = below.match(/\b(?:19|20)\d{2}\b/);
          if (y) { year = y[0]; break; }
        }
      }
      if (!year) continue;
      if (!candidates.has(c)) candidates.set(c, `${year}-${QUARTER_END[m[1].toLowerCase()]}`);
    }
  }

  // confirm each candidate looks like prices, and detect a flag column beside it
  const sample = rows.filter(isDataRow).slice(0, 60);
  const kept = [];
  for (const [col, key] of candidates) {
    let prices = 0, seen = 0;
    for (const row of sample) {
      const v = Number(String(row[col] ?? "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(v) || v === 0) continue;
      seen++;
      if (v >= MIN_PLAUSIBLE_PRICE) prices++;
    }
    if (seen < 5 || prices / seen < 0.6) continue;
    let flagLike = 0, flagSeen = 0;
    for (const row of sample) {
      const v = row[col + 1];
      if (v === undefined || v === null) continue;
      flagSeen++;
      if (typeof v === "string" && /^[\s^*]*$/.test(v)) flagLike++;
    }
    kept.push({ col, key, hasFlag: flagSeen >= 5 && flagLike / flagSeen >= 0.5 });
  }
  kept.sort((a, b) => a.col - b.col);
  // a quarter can only appear once per file; keep the leftmost occurrence
  const seenKeys = new Set();
  const quarters = kept.filter((q) => (seenKeys.has(q.key) ? false : seenKeys.add(q.key)));
  return { quarters, salesCols };
}

const geo = JSON.parse(fs.readFileSync(GEO_PATH, "utf8"));
const suburbByUpper = new Map(geo.features.map((f) => [f.properties.name.toUpperCase(), f.properties.name]));

// suburb -> class -> { "YYYY-MM": { median, flag } }, plus latest sale counts
const series = new Map();
const counts = new Map(); // suburb -> class -> { month, count }

function noteQuarter(name, cls, month, median, flag) {
  if (!series.has(name)) series.set(name, { houses: {}, units: {} });
  const existing = series.get(name)[cls][month];
  // Later releases restate earlier quarters; prefer an unflagged figure.
  if (!existing || (existing.flag && !flag)) series.get(name)[cls][month] = { median, flag };
}

const files = fs.existsSync(SALES_DIR) ? fs.readdirSync(SALES_DIR).filter((f) => /\.xlsx?$/i.test(f)) : [];
if (!files.length) {
  console.log("melbourne: no sales files (run scripts/fetch-melbourne-data.js), aborting");
  process.exit(0);
}
console.log(`Parsing ${files.length} quarterly sales files...`);

for (const file of files) {
  const cls = file.startsWith("unit") ? "units" : "houses";
  let sheet;
  try {
    sheet = readWorkbook(path.join(SALES_DIR, file)).sheets[0];
  } catch (e) {
    console.log(`  ${file}: unreadable (${String(e).slice(0, 60)})`);
    continue;
  }
  const rows = sheet.rows;
  const isDataRow = (row) => Boolean(row && typeof row[0] === "string" && suburbByUpper.has(row[0].trim().toUpperCase()));
  const { quarters, salesCols } = findQuarterColumns(rows, isDataRow);
  if (!quarters.length) { console.log(`  ${file}: no quarter columns confirmed`); continue; }

  const lastQuarter = quarters[quarters.length - 1];
  const countCol = salesCols.length ? salesCols[0] : null;
  let parsed = 0;
  for (const row of rows) {
    if (!isDataRow(row)) continue;
    const name = suburbByUpper.get(row[0].trim().toUpperCase());
    for (const q of quarters) {
      const median = Number(String(row[q.col] ?? "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(median) || median < MIN_PLAUSIBLE_PRICE) continue;
      const flag = q.hasFlag ? String(row[q.col + 1] ?? "").trim() : "";
      noteQuarter(name, cls, q.key, median, flag);
    }
    if (countCol != null) {
      const count = Number(String(row[countCol] ?? "").replace(/[^0-9]/g, ""));
      if (Number.isFinite(count) && count > 0) {
        if (!counts.has(name)) counts.set(name, {});
        const prev = counts.get(name)[cls];
        if (!prev || prev.month <= lastQuarter.key) counts.get(name)[cls] = { month: lastQuarter.key, count };
      }
    }
    parsed++;
  }
  console.log(`  ${file}: quarters ${quarters.map((q) => q.key).join(",")} · ${parsed} metro suburbs`);
}

// --- assemble -------------------------------------------------------------
const monthsBack = (key, n) => {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};

const suburbs = {};
const stats = { houses: 0, units: 0 };
for (const feature of geo.features) {
  const name = feature.properties.name;
  const rec = series.get(name) || { houses: {}, units: {} };
  const entry = {};
  for (const cls of ["houses", "units"]) {
    const byMonth = rec[cls] || {};
    const months = Object.keys(byMonth).sort();
    const latest = months[months.length - 1];
    const latestRec = latest ? byMonth[latest] : null;
    const usableLatest = latestRec && !latestRec.flag;

    let monthlyChangePct = null, change12mPct = null;
    if (usableLatest) {
      const prevKey = monthsBack(latest, 12);
      const prev = byMonth[prevKey];
      if (prev && !prev.flag && prev.median > 0) {
        const rate = Number((((latestRec.median / prev.median) ** (1 / 12) - 1) * 100).toFixed(2));
        if (Math.abs(rate) <= MAX_MONTHLY_MOVE) {
          monthlyChangePct = rate;
          change12mPct = Number(((latestRec.median / prev.median - 1) * 100).toFixed(1));
          stats[cls]++;
        }
      }
    }

    entry[cls] = {
      medianValue: latestRec ? latestRec.median : null,
      medianAsOf: latest || null,
      // A quarter flagged as thin (<10 sales) or carried forward shouldn't
      // anchor a yield any more than a stale price should.
      medianIsCurrent: Boolean(usableLatest),
      monthlyChangePct,
      change12mPct,
      salesInWindow: counts.get(name)?.[cls]?.count ?? null,
      history: months.map((m) => ({ month: m, median: byMonth[m].median })),
      sales: [], // Victoria does not publish individual sale records
      salesSummary: latestRec
        ? {
            period: `quarter ending ${latest}`,
            count: counts.get(name)?.[cls]?.count ?? null,
            median: latestRec.median,
            priorYears: months
              .slice(-9)
              .map((m) => ({ year: m, count: null, median: byMonth[m].median, flag: byMonth[m].flag || "" })),
          }
        : null,
    };
  }
  suburbs[name] = entry;
}

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "Victorian Property Sales Report, Land Use Victoria (CC BY 4.0)",
  method: "Quarterly median sale price per suburb, published separately for houses and units, merged across the overlapping quarterly releases. Trend compares the latest quarter with the same quarter a year earlier, expressed as %/month; quarters the report flags as fewer than ten sales, or carried forward because nothing sold, are excluded from trends and yields.",
  trendLabel: "12-month trend",
  classes: ["houses", "units"],
  suburbs,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(
  `Wrote ${Object.keys(suburbs).length} suburbs (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB): ` +
  `houses ${stats.houses} with trend, units ${stats.units} with trend`
);
