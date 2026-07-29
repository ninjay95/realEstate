// Builds site/data/sydney/market.json from real NSW Valuer General bulk
// Property Sales Information (run scripts/fetch-nsw-sales.sh first).
//
// Method: residential sales are grouped by locality and dwelling class
// (house vs unit, from the unit/strata-lot fields). The suburb's headline
// median and trend are computed on its DOMINANT class only — mixing classes
// makes the median jump when the sales mix shifts, not when prices move.
// For each month we take the median price of a 6-month trailing window
// (noise control for small suburbs — suburb-level quarterly medians swing
// wildly on heterogeneous stock). The trend compares the current window
// against the window 6 months earlier. A suburb needs MIN_TREND_SALES in
// both windows to get a trend; otherwise it is reported with whatever
// median exists and no trend.
//
// Usage: node scripts/build-market-sydney.js

const fs = require("fs");
const path = require("path");

const DAT_DIR = path.join(__dirname, "raw-nsw", "dat");
const GEO_PATH = path.join(__dirname, "..", "site", "data", "sydney", "suburbs.geojson");
const OUT_PATH = path.join(__dirname, "..", "site", "data", "sydney", "market.json");

const MONTHS_BACK = 25;      // window history depth
const MIN_WINDOW_SALES = 10; // minimum sales for a window median (QGSO precedent)
const MIN_TREND_SALES = 15;  // stricter minimum for computing a trend
const MIN_PRICE = 50000;     // filter out $1 family transfers etc.
const MAX_PRICE = 60000000;

const geo = JSON.parse(fs.readFileSync(GEO_PATH, "utf8"));
const suburbNames = new Set(geo.features.map((f) => f.properties.name.toUpperCase()));

// month keys, oldest -> newest, ending current month
const NOW = new Date();
const monthKeys = [];
for (let i = MONTHS_BACK - 1; i >= 0; i--) {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - i, 1));
  monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
}
const monthIndex = new Map(monthKeys.map((k, i) => [k, i]));

// --- parse all DAT files --------------------------------------------------
const files = fs.readdirSync(DAT_DIR).filter((f) => /\.dat$/i.test(f));
console.log(`Parsing ${files.length} DAT files...`);
const sales = new Map(); // suburb -> array of {t: monthIdx, date, price, address, unit}
const seen = new Set();
let total = 0, kept = 0;

for (const file of files) {
  const text = fs.readFileSync(path.join(DAT_DIR, file), "latin1");
  for (const line of text.split("\n")) {
    if (!line.startsWith("B;")) continue;
    total++;
    const f = line.split(";");
    if (f.length < 19) continue;
    const locality = (f[9] || "").trim().toUpperCase();
    if (!suburbNames.has(locality)) continue;
    const purpose = (f[18] || "").trim().toUpperCase();
    if (!purpose.startsWith("RESIDEN")) continue;
    const price = Number(f[15]);
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;
    const contract = (f[13] || "").trim();
    if (!/^\d{8}$/.test(contract)) continue;
    const mk = `${contract.slice(0, 4)}-${contract.slice(4, 6)}`;
    const mi = monthIndex.get(mk);
    if (mi === undefined) continue;
    const dedupe = `${f[2]}|${f[3]}|${contract}|${price}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const unitNo = (f[6] || "").trim();
    const houseNo = (f[7] || "").trim();
    const street = (f[8] || "").trim();
    const addr = `${unitNo ? unitNo + "/" : ""}${houseNo} ${street}`.trim();
    const postcode = (f[10] || "").trim();
    if (!sales.has(locality)) sales.set(locality, []);
    sales.get(locality).push({
      t: mi,
      postcode,
      date: `${contract.slice(0, 4)}-${contract.slice(4, 6)}-${contract.slice(6, 8)}`,
      price,
      address: addr
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      unit: Boolean(unitNo || (f[19] || "").trim()),
    });
    kept++;
  }
}
console.log(`B records: ${total}, kept residential sales in Sydney suburbs: ${kept}`);

// --- aggregate ------------------------------------------------------------
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const suburbs = {};
let withTrend = 0;
for (const feat of geo.features) {
  const name = feat.properties.name;
  const rows = sales.get(name.toUpperCase()) || [];
  // like-for-like: use the dominant dwelling class for median/trend
  const houseRows = rows.filter((r) => !r.unit);
  const unitRows = rows.filter((r) => r.unit);
  const clsRows = houseRows.length >= unitRows.length ? houseRows : unitRows;
  const trendClass = houseRows.length >= unitRows.length ? "houses" : "units";
  // rolling 6-month trailing windows per month index
  const winPrices = monthKeys.map((_, i) => clsRows.filter((r) => r.t <= i && r.t >= i - 5).map((r) => r.price));
  const rolling = winPrices.map((p) => (p.length >= MIN_WINDOW_SALES ? median(p) : null));

  // latest usable window
  let L = rolling.length - 1;
  while (L >= 0 && rolling[L] === null) L--;
  const history = [];
  for (let i = 0; i < rolling.length; i++) {
    if (rolling[i] !== null) history.push({ month: monthKeys[i], median: rolling[i] });
  }
  let monthlyChangePct = null, change12mPct = null;
  if (
    L >= 6 && rolling[L] !== null && rolling[L - 6] !== null &&
    winPrices[L].length >= MIN_TREND_SALES && winPrices[L - 6].length >= MIN_TREND_SALES
  ) {
    const rate = Number((((rolling[L] / rolling[L - 6]) ** (1 / 6) - 1) * 100).toFixed(2));
    // Sustained moves beyond ±5%/mo at suburb level are almost always the
    // sales mix changing (e.g. an off-the-plan tower settling), not prices.
    if (Math.abs(rate) <= 5) {
      monthlyChangePct = rate;
      withTrend++;
    }
  }
  if (L >= 12 && rolling[L] !== null && rolling[L - 12] !== null) {
    change12mPct = Number(((rolling[L] / rolling[L - 12] - 1) * 100).toFixed(1));
  }
  const recent = rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12).map((r) => ({
    date: r.date,
    price: r.price,
    address: r.address,
    type: r.unit ? "Unit" : "House",
  }));
  // postcodes the suburb's sales sit in (for matching postcode-level rent data)
  const pcCount = new Map();
  for (const r of rows) if (r.postcode) pcCount.set(r.postcode, (pcCount.get(r.postcode) || 0) + 1);
  const postcodes = [...pcCount.entries()]
    .filter(([, c]) => c >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);

  suburbs[name] = {
    medianValue: L >= 0 ? rolling[L] : null,
    medianAsOf: L >= 0 ? monthKeys[L] : null,
    monthlyChangePct,
    change12mPct,
    trendClass,
    postcodes,
    salesInWindow: L >= 0 ? winPrices[L].length : 0,
    history,
    sales: recent,
  };
}

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "NSW Valuer General bulk Property Sales Information (open access)",
  method: "Median of residential sales of the suburb's dominant dwelling class (houses or units) in 6-month trailing windows by contract date; trend is the %/month change between the current window and the window 6 months earlier; minimum 15 sales per window for a trend; rates beyond ±5%/mo are treated as composition noise and suppressed.",
  trendLabel: "6-month trend",
  suburbs,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
const all = Object.values(suburbs);
const falling = all.filter((s) => s.monthlyChangePct !== null && s.monthlyChangePct <= -0.25).length;
const rising = all.filter((s) => s.monthlyChangePct !== null && s.monthlyChangePct >= 0.25).length;
console.log(`Wrote ${all.length} suburbs (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB): ${withTrend} with trend (${falling} falling, ${rising} rising), ${all.length - withTrend} insufficient data`);
