// Builds site/data/brisbane/market.json from real data fetched by
// scripts/fetch-brisbane-data.js:
//
//  - Current median + sales counts per SA2: QGSO Housing Profiles
//    (QVAS database, 12 months ending Dec 2025, CC BY 4.0)
//  - Historical annual medians per SA2: ABS "Data by region"
//    (established house / attached dwelling transfers, year ended 30 June)
//
// Trend: like-for-like comparison of the QGSO 12-month median against the
// ABS FY2024 median for the same dwelling class (detached preferred,
// attached as fallback), annualised over the 18 months between the two
// periods' midpoints (Dec 2023 -> Jun 2025) and expressed as %/month.
//
// Usage: node scripts/build-market-brisbane.js

const fs = require("fs");
const path = require("path");

const RAW = path.join(__dirname, "raw-brisbane");
const GEO_PATH = path.join(__dirname, "..", "site", "data", "brisbane", "suburbs.geojson");
const OUT_PATH = path.join(__dirname, "..", "site", "data", "brisbane", "market.json");

const GAP_MONTHS = 18; // midpoint Dec 2023 (ABS FY2024) -> midpoint Jun 2025 (QGSO cal 2025)
const MIN_COUNT = 10;  // both sources suppress medians under 10 sales anyway

const geo = JSON.parse(fs.readFileSync(GEO_PATH, "utf8"));
const qgso = JSON.parse(fs.readFileSync(path.join(RAW, "qgso-sales.json"), "utf8"));

// ABS CSV -> abs[code][measure][year] = value
const abs = {};
const csv = fs.readFileSync(path.join(RAW, "abs-houses.csv"), "utf8").trim().split("\n");
for (const line of csv.slice(1)) {
  const c = line.split(",");
  const [_, measure, __, code, ___, year, value] = c;
  if (!value) continue;
  ((abs[code] ??= {})[measure] ??= {})[year] = Number(value);
}

const suburbs = {};
let withTrend = 0, noData = 0;
for (const feat of geo.features) {
  const name = feat.properties.name;
  const code = feat.properties.code;
  const q = qgso[name];
  const a = abs[code] || {};
  const houses = a.HOUSES_3 || {}; // median established house price by FY
  const units = a.HOUSES_5 || {};  // median attached dwelling price by FY
  const houseCounts = a.HOUSES_2 || {};
  const unitCounts = a.HOUSES_4 || {};

  // pick the dwelling class with usable data on both sides
  let cls = null, qgsoMedian = null, absMedian = null;
  if (q && q.ok) {
    if (q.detachedMedian && (q.detachedCount ?? 0) >= MIN_COUNT && houses["2024"]) {
      cls = "detached"; qgsoMedian = q.detachedMedian; absMedian = houses["2024"];
    } else if (q.attachedMedian && (q.attachedCount ?? 0) >= MIN_COUNT && units["2024"]) {
      cls = "attached"; qgsoMedian = q.attachedMedian; absMedian = units["2024"];
    }
  }

  let monthlyChangePct = null, changeTotalPct = null;
  if (cls) {
    monthlyChangePct = Number((((qgsoMedian / absMedian) ** (1 / GAP_MONTHS) - 1) * 100).toFixed(2));
    changeTotalPct = Number(((qgsoMedian / absMedian - 1) * 100).toFixed(1));
    withTrend++;
  } else {
    noData++;
  }

  // history sparkline: ABS annual series for the chosen class + QGSO endpoint
  const series = cls === "attached" ? units : houses;
  const history = Object.keys(series).sort().map((y) => ({ month: `${y}-06`, median: series[y] }));
  if (cls && qgsoMedian) history.push({ month: "2025-12", median: qgsoMedian });

  suburbs[name] = {
    medianValue: q && q.ok ? q.totalMedian ?? qgsoMedian : (houses["2024"] ?? units["2024"] ?? null),
    medianAsOf: q && q.ok && q.period ? q.period : "FY2024",
    monthlyChangePct,
    change18mPct: changeTotalPct,
    trendClass: cls,
    history,
    sales: [], // individual QLD sales records are not open data
    salesSummary: q && q.ok ? {
      period: q.period || "12 months ending 31 December 2025",
      detached: { count: q.detachedCount, median: q.detachedMedian },
      attached: { count: q.attachedCount, median: q.attachedMedian },
      total: { count: q.totalCount, median: q.totalMedian },
      priorYears: Object.keys(houses).sort().map((y) => ({
        year: `FY${y}`,
        houseMedian: houses[y] ?? null,
        houseCount: houseCounts[y] ?? null,
        unitMedian: units[y] ?? null,
        unitCount: unitCounts[y] ?? null,
      })),
    } : null,
  };
}

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "QGSO Queensland Housing Profiles (QVAS database, CC BY 4.0) + ABS Data by region (annual SA2 medians)",
  method: "QVAS 12-month median (to Dec 2025) compared like-for-like against the ABS FY2024 median for the same dwelling class; change annualised over the 18 months between period midpoints, expressed as %/month.",
  trendLabel: "18-month trend",
  suburbs,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
const all = Object.values(suburbs);
const falling = all.filter((s) => s.monthlyChangePct !== null && s.monthlyChangePct <= -0.25).length;
const rising = all.filter((s) => s.monthlyChangePct !== null && s.monthlyChangePct >= 0.25).length;
console.log(`Wrote ${all.length} SA2s (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB): ${withTrend} with trend (${falling} falling, ${rising} rising), ${noData} without`);
