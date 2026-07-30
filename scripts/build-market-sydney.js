// Builds site/data/sydney/market.json from real NSW Valuer General bulk
// Property Sales Information (run scripts/fetch-nsw-sales.sh first).
//
// Output is PER DWELLING CLASS — houses and units are separate markets and
// mixing them makes a median move when the sales mix shifts rather than when
// prices do. A sale counts as a unit when it carries a unit number or a strata
// lot (so strata townhouses land with units); everything else is a house.
//
// For each class: the median of a 6-month trailing window of sales by contract
// date, a monthly series of those windows, and the %/month change against the
// window 6 months earlier. Windows need MIN_WINDOW_SALES for a median and
// MIN_TREND_SALES at both ends for a trend.
//
// Usage: node scripts/build-market-sydney.js

const fs = require("fs");
const path = require("path");

const DAT_DIR = path.join(__dirname, "raw-nsw", "dat");
const GEO_PATH = path.join(__dirname, "..", "site", "data", "sydney", "suburbs.geojson");
const OUT_PATH = path.join(__dirname, "..", "site", "data", "sydney", "market.json");

const MONTHS_BACK = 25;
const MIN_WINDOW_SALES = 10;
const MIN_TREND_SALES = 15;
const MAX_MONTHLY_MOVE = 5; // beyond this it's composition noise, not prices
const RECENT_SALES = 10;
const MIN_PRICE = 50000;
const MAX_PRICE = 60000000;

const geo = JSON.parse(fs.readFileSync(GEO_PATH, "utf8"));
const suburbNames = new Set(geo.features.map((f) => f.properties.name.toUpperCase()));

const NOW = new Date();
const monthKeys = [];
for (let i = MONTHS_BACK - 1; i >= 0; i--) {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - i, 1));
  monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
}
const monthIndex = new Map(monthKeys.map((k, i) => [k, i]));

// --- parse all DAT files --------------------------------------------------
// Two passes are needed. A single transaction that buys several lots at once
// (a developer amalgamation) is recorded once per lot with the WHOLE deal price
// on each row — one $41.2M Rhodes purchase appears as seven $41.2M "sales".
// Left in, those rows wreck the median of any suburb where they happen, and
// they hit exactly the high-density suburbs where few real houses trade.
//
// They show up two ways, so pass 1 indexes both and pass 2 drops both:
//   1. several lots sharing one dealing number
//   2. several lots at the identical price on the identical contract date
//      (the same deal registered as separate dealings — e.g. eight St Leonards
//      properties all at $10,057,261 on 2025-12-23)
const files = fs.readdirSync(DAT_DIR).filter((f) => /\.dat$/i.test(f));
console.log(`Parsing ${files.length} DAT files...`);

const fields = (line) => line.split(";");
const isResidential = (f) => (f[18] || "").trim().toUpperCase().startsWith("RESIDEN");
const MULTI = "*";

// Each map holds a single property id, or MULTI once a second one is seen.
const dealingLots = new Map();
const priceGroups = new Map();
const note = (map, key, propId) => {
  const prev = map.get(key);
  if (prev === undefined) map.set(key, propId);
  else if (prev !== propId && prev !== MULTI) map.set(key, MULTI);
};

for (const file of files) {
  const text = fs.readFileSync(path.join(DAT_DIR, file), "latin1");
  for (const line of text.split("\n")) {
    if (!line.startsWith("B;")) continue;
    const f = fields(line);
    if (f.length < 24 || !isResidential(f)) continue;
    const propId = (f[2] || "").trim();
    const dealing = (f[23] || "").trim();
    if (dealing) note(dealingLots, dealing, propId);
    const contract = (f[13] || "").trim();
    const price = (f[15] || "").trim();
    if (contract && price) note(priceGroups, `${(f[9] || "").trim()}|${contract}|${price}`, propId);
  }
}

const sales = new Map(); // suburb -> rows
const seen = new Set();
let total = 0, kept = 0, multiLot = 0, dupes = 0;

for (const file of files) {
  const text = fs.readFileSync(path.join(DAT_DIR, file), "latin1");
  for (const line of text.split("\n")) {
    if (!line.startsWith("B;")) continue;
    total++;
    const f = fields(line);
    if (f.length < 20) continue;
    const locality = (f[9] || "").trim().toUpperCase();
    if (!suburbNames.has(locality)) continue;
    if (!isResidential(f)) continue;
    const price = Number(f[15]);
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;
    const contract = (f[13] || "").trim();
    if (!/^\d{8}$/.test(contract)) continue;
    const mk = `${contract.slice(0, 4)}-${contract.slice(4, 6)}`;
    const mi = monthIndex.get(mk);
    if (mi === undefined) continue;

    const dealing = (f[23] || "").trim();
    const sameDeal =
      (dealing && dealingLots.get(dealing) === MULTI) ||
      priceGroups.get(`${(f[9] || "").trim()}|${contract}|${(f[15] || "").trim()}`) === MULTI;
    if (sameDeal) { multiLot++; continue; }

    // Stable identity only — the 4th field is a per-file counter, so including
    // it would let a republished sale through twice.
    const dedupe = `${(f[2] || "").trim()}|${contract}|${price}`;
    if (seen.has(dedupe)) { dupes++; continue; }
    seen.add(dedupe);

    const unitNo = (f[6] || "").trim();
    const strataLot = (f[19] || "").trim();
    const houseNo = (f[7] || "").trim();
    const street = (f[8] || "").trim();
    const addr = `${unitNo ? unitNo + "/" : ""}${houseNo} ${street}`.trim();
    if (!sales.has(locality)) sales.set(locality, []);
    sales.get(locality).push({
      t: mi,
      postcode: (f[10] || "").trim(),
      date: `${contract.slice(0, 4)}-${contract.slice(4, 6)}-${contract.slice(6, 8)}`,
      price,
      address: addr.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
      isUnit: Boolean(unitNo || strataLot),
    });
    kept++;
  }
}
console.log(
  `B records: ${total}; kept ${kept} residential sales in Sydney suburbs ` +
  `(dropped ${multiLot} multi-lot transaction rows, ${dupes} republished duplicates)`
);

// --- aggregate per class --------------------------------------------------
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

function classStats(rows) {
  const winPrices = monthKeys.map((_, i) => rows.filter((r) => r.t <= i && r.t >= i - 5).map((r) => r.price));
  const rolling = winPrices.map((p) => (p.length >= MIN_WINDOW_SALES ? median(p) : null));

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
    if (Math.abs(rate) <= MAX_MONTHLY_MOVE) monthlyChangePct = rate;
  }
  if (L >= 12 && rolling[L] !== null && rolling[L - 12] !== null) {
    change12mPct = Number(((rolling[L] / rolling[L - 12] - 1) * 100).toFixed(1));
  }

  const recent = [...rows]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_SALES)
    .map((r) => ({ date: r.date, price: r.price, address: r.address }));

  return {
    medianValue: L >= 0 ? rolling[L] : null,
    medianAsOf: L >= 0 ? monthKeys[L] : null,
    monthlyChangePct,
    change12mPct,
    salesInWindow: L >= 0 ? winPrices[L].length : 0,
    salesTotal: rows.length,
    history,
    sales: recent,
  };
}

const STALE_MONTHS = 6; // a price older than this shouldn't anchor a yield
const monthsApart = (a, b) => {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};

const suburbs = {};
const counts = { houses: { trend: 0 }, units: { trend: 0 } };
for (const feat of geo.features) {
  const name = feat.properties.name;
  const rows = sales.get(name.toUpperCase()) || [];

  const pcCount = new Map();
  for (const r of rows) if (r.postcode) pcCount.set(r.postcode, (pcCount.get(r.postcode) || 0) + 1);
  const postcodes = [...pcCount.entries()]
    .filter(([, c]) => c >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);

  const houses = classStats(rows.filter((r) => !r.isUnit));
  const units = classStats(rows.filter((r) => r.isUnit));
  if (houses.monthlyChangePct != null) counts.houses.trend++;
  if (units.monthlyChangePct != null) counts.units.trend++;

  suburbs[name] = { postcodes, houses, units };
}

// Not every suburb trades every month, so a "latest" window can be a year old.
// Flag whether each median is recent enough to anchor a rental yield; the panel
// still shows the figure with its as-at date either way.
const latestMonth = Object.values(suburbs)
  .flatMap((s) => [s.houses.medianAsOf, s.units.medianAsOf])
  .filter(Boolean)
  .sort()
  .pop();
let stale = 0;
for (const s of Object.values(suburbs)) {
  for (const cls of ["houses", "units"]) {
    const rec = s[cls];
    rec.medianIsCurrent = Boolean(
      rec.medianAsOf && latestMonth && monthsApart(rec.medianAsOf, latestMonth) <= STALE_MONTHS
    );
    if (rec.medianAsOf && !rec.medianIsCurrent) stale++;
  }
}

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "NSW Valuer General bulk Property Sales Information (open access)",
  method: "Median of residential sales by contract date in 6-month trailing windows, computed separately for houses and units (a sale is a unit when it carries a unit number or strata lot). Multi-lot transactions — one deal recorded against several lots, each row carrying the whole price — are excluded, identified either by a shared dealing number or by an identical price on an identical contract date across different properties. Trend is the %/month change against the window 6 months earlier; minimum 15 sales at both ends, and moves beyond ±5%/mo are suppressed as composition noise.",
  trendLabel: "6-month trend",
  classes: ["houses", "units"],
  suburbs,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(
  `Wrote ${Object.keys(suburbs).length} suburbs (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB): ` +
  `houses ${counts.houses.trend} with trend, units ${counts.units.trend} with trend; ` +
  `${stale} class medians older than ${STALE_MONTHS} months (no yield)`
);
