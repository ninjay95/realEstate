// Generates site/data/market.json — sample sales/valuation data for every
// suburb in site/data/suburbs.geojson.
//
// This stands in for a real data feed (Domain, CoreLogic, NSW Valuer General
// bulk data, etc.). The site only depends on the shape written here, so a real
// integration just has to produce the same JSON:
//
// {
//   "generatedAt": "2026-07-25",
//   "suburbs": {
//     "<Suburb Name>": {
//       "medianValue": 1480000,          // current estimated median (AUD)
//       "monthlyChangePct": -1.32,       // avg %/month over the last 6 months
//       "change12mPct": -9.8,            // % change over 12 months
//       "history": [{ "month": "2024-08", "median": 1610000 }, ...x24],
//       "sales": [{ "date": "2026-07-03", "price": 1425000, "address": "…",
//                    "beds": 3, "baths": 2, "type": "House" }, ...]
//     }
//   }
// }
//
// Deterministic: same suburb name -> same numbers on every run.
// Usage: node scripts/generate-market.js

const fs = require("fs");
const path = require("path");

const suburbsPath = path.join(__dirname, "..", "site", "data", "suburbs.geojson");
const outPath = path.join(__dirname, "..", "site", "data", "market.json");

const CBD = { lng: 151.2073, lat: -33.8688 }; // Sydney CBD
const MONTHS = 24;
const LAST_MONTH = { y: 2026, m: 7 }; // most recent history month (July 2026)

// --- deterministic RNG per suburb ---------------------------------------
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREETS = ["Acacia", "Banksia", "Carrington", "Denison", "Eucalyptus", "Fitzroy",
  "Grandview", "Hillcrest", "Ironbark", "Jacaranda", "Kurraba", "Lawson", "Macquarie",
  "Norfolk", "Oxford", "Panorama", "Queens", "Rosebery", "Stanley", "Terrigal",
  "Undercliff", "Victoria", "Waratah", "York"];
const STREET_TYPES = ["St", "Rd", "Ave", "Pde", "Cres", "Pl"];
const TYPES = ["House", "House", "House", "Townhouse", "Apartment", "Apartment"];

function monthLabel(offsetBack) {
  // offsetBack = 0 -> LAST_MONTH, 1 -> the month before, ...
  let y = LAST_MONTH.y, m = LAST_MONTH.m - offsetBack;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

const geo = JSON.parse(fs.readFileSync(suburbsPath, "utf8"));
const suburbs = {};

for (const f of geo.features) {
  const name = f.properties.name;
  const [lng, lat] = f.properties.centroid;
  const rng = mulberry32(hashString(name));

  // Distance to CBD in rough km — drives the price baseline.
  const dx = (lng - CBD.lng) * 92.6; // km per degree lon at Sydney's latitude
  const dy = (lat - CBD.lat) * 111.2;
  const distKm = Math.sqrt(dx * dx + dy * dy);

  // Baseline median: ~$2.6M near the CBD easing to ~$850K at 45 km out, ±25% noise.
  const base = 2600000 * Math.exp(-distKm / 28) + 700000;
  const median0 = base * (0.75 + rng() * 0.5);

  // Trend regime: roughly 45% of suburbs cooling, 20% flat, 35% still climbing.
  // Cooling is slightly more likely further out (rate rises bite harder there).
  const coolBias = Math.min(0.18, distKm / 250);
  const roll = rng() - coolBias;
  let trend; // avg monthly drift, fraction
  if (roll < 0.40) trend = -(0.003 + rng() * 0.022);      // -0.3% .. -2.5% /mo
  else if (roll < 0.60) trend = (rng() - 0.5) * 0.004;    // ~flat
  else trend = 0.002 + rng() * 0.010;                     // +0.2% .. +1.2% /mo

  // 24-month history: mild drift for the first year, the trend regime kicks in
  // over the last ~9 months (mirrors the "recent shift" the map is hunting for).
  const history = [];
  let value = median0;
  const drifts = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const regime = i <= 9 ? trend : trend * 0.25;
    const noise = (rng() - 0.5) * 0.008;
    drifts.push({ i, drift: regime + noise });
  }
  // Walk backwards from today's value so medianValue matches history[last].
  const factors = drifts.map((d) => 1 + d.drift);
  let cursor = value;
  const values = new Array(MONTHS);
  values[MONTHS - 1] = cursor;
  for (let k = MONTHS - 1; k > 0; k--) cursor = cursor / factors[k], (values[k - 1] = cursor);
  for (let k = 0; k < MONTHS; k++) {
    history.push({ month: monthLabel(MONTHS - 1 - k), median: Math.round(values[k] / 1000) * 1000 });
  }

  const current = history[MONTHS - 1].median;
  const sixAgo = history[MONTHS - 7].median;
  const twelveAgo = history[MONTHS - 13].median;
  const monthlyChangePct = ((current / sixAgo) ** (1 / 6) - 1) * 100;
  const change12mPct = (current / twelveAgo - 1) * 100;

  // Recent sales: 4–12 in the last ~90 days, scattered around the median.
  const nSales = 4 + Math.floor(rng() * 9);
  const sales = [];
  for (let s = 0; s < nSales; s++) {
    const daysAgo = Math.floor(rng() * 90);
    const d = new Date(Date.UTC(2026, 6, 25) - daysAgo * 86400000);
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    const typeMul = type === "Apartment" ? 0.55 + rng() * 0.2 : type === "Townhouse" ? 0.8 + rng() * 0.15 : 0.9 + rng() * 0.35;
    sales.push({
      date: d.toISOString().slice(0, 10),
      price: Math.round((current * typeMul) / 5000) * 5000,
      address: `${1 + Math.floor(rng() * 180)} ${STREETS[Math.floor(rng() * STREETS.length)]} ${STREET_TYPES[Math.floor(rng() * STREET_TYPES.length)]}`,
      beds: type === "Apartment" ? 1 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 4),
      baths: 1 + Math.floor(rng() * 3),
      type,
    });
  }
  sales.sort((a, b) => b.date.localeCompare(a.date));

  suburbs[name] = {
    medianValue: current,
    monthlyChangePct: Number(monthlyChangePct.toFixed(2)),
    change12mPct: Number(change12mPct.toFixed(1)),
    history,
    sales,
  };
}

fs.writeFileSync(outPath, JSON.stringify({ generatedAt: "2026-07-25", disclaimer: "Sample data for demonstration — not real sales or valuations.", suburbs }));
const kb = Math.round(fs.statSync(outPath).size / 1024);
const all = Object.values(suburbs);
const falling = all.filter((s) => s.monthlyChangePct <= -0.25).length;
const rising = all.filter((s) => s.monthlyChangePct >= 0.25).length;
console.log(`Wrote ${all.length} suburbs (${kb} KB): ${falling} falling, ${rising} rising, ${all.length - falling - rising} flat`);
