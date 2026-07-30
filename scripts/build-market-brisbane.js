// Builds site/data/brisbane/market.json from real data fetched by
// scripts/fetch-brisbane-data.js, PER DWELLING CLASS:
//
//  houses — QGSO detached-dwelling median (QVAS, 12 months to Dec 2025)
//           against the ABS "established house transfers" annual series
//  units  — QGSO attached-dwelling median against the ABS "attached dwelling
//           transfers" annual series
//
// Trend for each class compares the QVAS 12-month median against that class's
// ABS FY2024 median, annualised over the 18 months between the two periods'
// midpoints (Dec 2023 -> Jun 2025) and expressed as %/month. Comparing a class
// only ever against itself keeps the move about prices, not the sales mix.
//
// Usage: node scripts/build-market-brisbane.js

const fs = require("fs");
const path = require("path");

const RAW = path.join(__dirname, "raw-brisbane");
const GEO_PATH = path.join(__dirname, "..", "site", "data", "brisbane", "suburbs.geojson");
const OUT_PATH = path.join(__dirname, "..", "site", "data", "brisbane", "market.json");

const GAP_MONTHS = 18;
// Both sources suppress medians under 10 sales, but 10-20 sale medians at SA2
// level swing wildly (one outer-suburb ABS attached series runs 110k -> 300k ->
// 370k on samples of 9-23). A trend needs a decent sample at BOTH ends.
const MIN_TREND_COUNT = 20;
const MAX_MONTHLY_MOVE = 3; // over an 18-month window, beyond this is noise

const geo = JSON.parse(fs.readFileSync(GEO_PATH, "utf8"));
const qgso = JSON.parse(fs.readFileSync(path.join(RAW, "qgso-sales.json"), "utf8"));

// ABS CSV -> abs[code][measure][year]
const abs = {};
const csv = fs.readFileSync(path.join(RAW, "abs-houses.csv"), "utf8").trim().split("\n");
for (const line of csv.slice(1)) {
  const c = line.split(",");
  const [, measure, , code, , year, value] = c;
  if (!value) continue;
  ((abs[code] ??= {})[measure] ??= {})[year] = Number(value);
}

// ABS measures: HOUSES_2/3 = established house count/median,
//               HOUSES_4/5 = attached dwelling count/median
const CLASS_SPEC = {
  houses: { absMedian: "HOUSES_3", absCount: "HOUSES_2", qgsoMedian: "detachedMedian", qgsoCount: "detachedCount" },
  units: { absMedian: "HOUSES_5", absCount: "HOUSES_4", qgsoMedian: "attachedMedian", qgsoCount: "attachedCount" },
};

function classStats(q, a, spec) {
  const series = a[spec.absMedian] || {};
  const countSeries = a[spec.absCount] || {};
  const current = q && q.ok ? q[spec.qgsoMedian] : null;
  const currentCount = q && q.ok ? q[spec.qgsoCount] : null;
  const baseline = series["2024"];

  let monthlyChangePct = null, change18mPct = null;
  const baselineCount = countSeries["2024"] ?? 0;
  if (current && baseline && currentCount >= MIN_TREND_COUNT && baselineCount >= MIN_TREND_COUNT) {
    const rate = Number((((current / baseline) ** (1 / GAP_MONTHS) - 1) * 100).toFixed(2));
    if (Math.abs(rate) <= MAX_MONTHLY_MOVE) {
      monthlyChangePct = rate;
      change18mPct = Number(((current / baseline - 1) * 100).toFixed(1));
    }
  }

  const history = Object.keys(series).sort().map((y) => ({ month: `${y}-06`, median: series[y] }));
  if (current) history.push({ month: "2025-12", median: current });

  return {
    medianValue: current ?? baseline ?? null,
    medianAsOf: current ? (q.period || "31 December 2025") : baseline ? "FY2024" : null,
    // A yield must not divide today's rent by a two-year-old price, so flag
    // whether the median above is the current QVAS one or the ABS fallback.
    medianIsCurrent: Boolean(current),
    monthlyChangePct,
    change18mPct,
    salesInWindow: currentCount ?? null,
    history,
    sales: [], // individual QLD sales records are not open data
    salesSummary: {
      period: (q && q.ok && q.period) || "12 months ending 31 December 2025",
      count: currentCount ?? null,
      median: current ?? null,
      priorYears: Object.keys(series).sort().map((y) => ({
        year: `FY${y}`,
        count: countSeries[y] ?? null,
        median: series[y] ?? null,
      })),
    },
  };
}

const suburbs = {};
const counts = { houses: 0, units: 0 };
for (const feat of geo.features) {
  const name = feat.properties.name;
  const a = abs[feat.properties.code] || {};
  const q = qgso[name];
  const houses = classStats(q, a, CLASS_SPEC.houses);
  const units = classStats(q, a, CLASS_SPEC.units);
  if (houses.monthlyChangePct != null) counts.houses++;
  if (units.monthlyChangePct != null) counts.units++;
  suburbs[name] = { houses, units };
}

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "QGSO Queensland Housing Profiles (QVAS database, CC BY 4.0) + ABS Data by region (annual SA2 medians)",
  method: "For each dwelling class, the QVAS 12-month median (to Dec 2025) compared against that same class's ABS FY2024 median; change annualised over the 18 months between period midpoints, expressed as %/month. A trend needs at least 20 sales at both ends and moves beyond ±3%/mo are suppressed as small-sample noise.",
  trendLabel: "18-month trend",
  classes: ["houses", "units"],
  suburbs,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(
  `Wrote ${Object.keys(suburbs).length} SA2s (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB): ` +
  `houses ${counts.houses} with trend, units ${counts.units} with trend`
);
