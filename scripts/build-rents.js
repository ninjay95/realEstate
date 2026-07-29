// Builds site/data/<city>/rents.json — real median weekly rents and the gross
// rental yield they imply against the median sale price in market.json.
//
// Sydney   — NSW Fair Trading rental bond lodgements (every bond lodged, with
//            postcode / dwelling type / bedrooms / weekly rent). Rents are only
//            published at POSTCODE level, so a suburb inherits the median of
//            the postcode(s) its sales sit in (recorded in market.json).
//            Run scripts/fetch-nsw-rents.sh first.
// Brisbane — QGSO Housing Profiles median rents per SA2, derived by Queensland
//            Treasury from Residential Tenancies Authority bond lodgements.
//            Run scripts/fetch-rents-brisbane.js first.
//
// Gross yield = median weekly rent x 52 / median sale price, matched to the
// same dwelling class (houses vs units) on both sides.
//
// Usage: node scripts/build-rents.js

const fs = require("fs");
const path = require("path");
const { readSheet } = require("./lib/xlsx-lite");

const MIN_RENT_SAMPLE = 10;  // both sources suppress medians below ~10
const RENT_FLOOR = 80;       // filter data-entry errors
const RENT_CEILING = 15000;

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const dataPath = (city, file) => path.join(__dirname, "..", "site", "data", city, file);

function yieldPct(weeklyRent, price) {
  if (!weeklyRent || !price) return null;
  return Number((((weeklyRent * 52) / price) * 100).toFixed(2));
}

// ---------------------------------------------------------------- Sydney ----
function buildSydney() {
  const rentsDir = path.join(__dirname, "raw-nsw", "rents");
  if (!fs.existsSync(rentsDir)) {
    console.log("sydney: no bond data (run scripts/fetch-nsw-rents.sh), skipping");
    return;
  }
  const files = fs.readdirSync(rentsDir).filter((f) => /\.xlsx$/i.test(f));
  console.log(`sydney: reading ${files.length} monthly bond files...`);

  // postcode -> class -> [rents], plus per-bedroom detail for the panel
  const byPostcode = new Map();
  let kept = 0, total = 0;
  const months = new Set();
  for (const file of files) {
    const { rows } = readSheet(path.join(rentsDir, file), 0);
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 5) continue;
      total++;
      const postcode = String(r[1] || "").trim();
      const dwelling = String(r[2] || "").trim().toUpperCase();
      const beds = String(r[3] || "").trim();
      const rent = Number(r[4]);
      // (F) Flat/unit and (H) House are the two classes our sale medians use.
      const cls = dwelling === "F" ? "units" : dwelling === "H" ? "houses" : null;
      if (!cls || !/^\d{4}$/.test(postcode)) continue;
      if (!Number.isFinite(rent) || rent < RENT_FLOOR || rent > RENT_CEILING) continue;
      if (!byPostcode.has(postcode)) byPostcode.set(postcode, { houses: [], units: [], beds: {} });
      const bucket = byPostcode.get(postcode);
      bucket[cls].push(rent);
      const bedKey = `${cls}:${/^\d+$/.test(beds) ? beds : "?"}`;
      (bucket.beds[bedKey] ??= []).push(rent);
      kept++;
    }
    months.add(file.replace(/rentalbond_lodgements_|\.xlsx/g, ""));
  }
  console.log(`sydney: ${kept} usable lodgements of ${total} rows`);

  const market = JSON.parse(fs.readFileSync(dataPath("sydney", "market.json"), "utf8"));
  const suburbs = {};
  let withYield = 0;
  for (const [name, m] of Object.entries(market.suburbs)) {
    const cls = m.trendClass || "houses";
    const pcs = m.postcodes || [];
    const pool = [];
    const bedPool = {};
    for (const pc of pcs) {
      const bucket = byPostcode.get(pc);
      if (!bucket) continue;
      pool.push(...bucket[cls]);
      for (const [k, v] of Object.entries(bucket.beds)) {
        if (!k.startsWith(cls + ":")) continue;
        (bedPool[k.split(":")[1]] ??= []).push(...v);
      }
    }
    const enough = pool.length >= MIN_RENT_SAMPLE;
    const weekly = enough ? median(pool) : null;
    const gross = enough ? yieldPct(weekly, m.medianValue) : null;
    if (gross != null) withYield++;
    suburbs[name] = {
      medianWeeklyRent: weekly,
      rentSample: pool.length,
      rentClass: cls,
      rentScope: pcs.length ? `postcode ${pcs.slice(0, 3).join(", ")}` : null,
      priceUsed: m.medianValue, // already the dominant-class median
      grossYieldPct: gross,
      byBedrooms: Object.fromEntries(
        Object.entries(bedPool)
          .filter(([, v]) => v.length >= MIN_RENT_SAMPLE)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([k, v]) => [k, { median: median(v), count: v.length }])
      ),
    };
  }
  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "NSW Fair Trading rental bond lodgements (postcode level)",
    method: `Median weekly rent from ${files.length} months of bond lodgements, matched to the suburb's dominant dwelling class (Flat/unit or House). Rents are published by postcode, so suburbs sharing a postcode share a rent median. Gross yield = weekly rent x 52 / median sale price.`,
    monthsIncluded: files.length,
    suburbs,
  };
  fs.writeFileSync(dataPath("sydney", "rents.json"), JSON.stringify(out));
  console.log(`sydney: wrote ${Object.keys(suburbs).length} suburbs, ${withYield} with a yield (${Math.round(fs.statSync(dataPath("sydney", "rents.json")).size / 1024)} KB)`);
}

// -------------------------------------------------------------- Brisbane ----
function buildBrisbane() {
  const rentPath = path.join(__dirname, "raw-brisbane", "qgso-rents.json");
  if (!fs.existsSync(rentPath)) {
    console.log("brisbane: no QGSO rent data (run scripts/fetch-rents-brisbane.js), skipping");
    return;
  }
  const raw = JSON.parse(fs.readFileSync(rentPath, "utf8"));
  const market = JSON.parse(fs.readFileSync(dataPath("brisbane", "market.json"), "utf8"));
  const suburbs = {};
  let withYield = 0, period = null;

  for (const [name, m] of Object.entries(market.suburbs)) {
    const q = raw[name];
    const cls = m.trendClass === "attached" ? "units" : "houses";
    let weekly = null, sample = 0;
    if (q && q.ok) {
      period = period || q.period;
      // QGSO publishes 1/2-bed flat-unit and 3/4-bed house medians. Combine the
      // available ones for the class, weighted by lodgement count, so the rent
      // reflects the same mix of stock the sale median covers.
      const keys = cls === "units" ? ["unit1", "unit2"] : ["house3", "house4"];
      let num = 0, den = 0;
      for (const k of keys) {
        const rent = q.medianRent[k], n = q.lodgements[k];
        if (rent && n && n >= MIN_RENT_SAMPLE) { num += rent * n; den += n; }
      }
      if (den > 0) { weekly = Math.round(num / den); sample = den; }
    }
    // Brisbane's headline median covers ALL dwellings, but the rent above is
    // class-specific — divide by the matching class median or the yield is junk
    // (e.g. house rent over a unit-dominated all-dwelling median).
    const summary = m.salesSummary;
    const classPrice = summary
      ? (cls === "units" ? summary.attached?.median : summary.detached?.median) ?? m.medianValue
      : m.medianValue;
    const gross = yieldPct(weekly, classPrice);
    if (gross != null) withYield++;
    suburbs[name] = {
      medianWeeklyRent: weekly,
      rentSample: sample,
      rentClass: cls,
      rentScope: q && q.ok ? "SA2" : null,
      priceUsed: classPrice,
      grossYieldPct: gross,
      byBedrooms: q && q.ok
        ? Object.fromEntries(
            [["1 bed unit", "unit1"], ["2 bed unit", "unit2"], ["3 bed house", "house3"], ["4 bed house", "house4"]]
              .filter(([, k]) => q.medianRent[k])
              .map(([label, k]) => [label, { median: q.medianRent[k], count: q.lodgements[k] }])
          )
        : {},
    };
  }
  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "Residential Tenancies Authority bond lodgements via QGSO Housing Profiles (SA2 level)",
    method: `Median weekly rent for ${period || "the latest 12-month period"}, combining the published bedroom categories for the area's dominant dwelling class weighted by lodgement count. Gross yield = weekly rent x 52 / the median sale price for that same dwelling class (not the all-dwellings median).`,
    period,
    suburbs,
  };
  fs.writeFileSync(dataPath("brisbane", "rents.json"), JSON.stringify(out));
  console.log(`brisbane: wrote ${Object.keys(suburbs).length} SA2s, ${withYield} with a yield (${Math.round(fs.statSync(dataPath("brisbane", "rents.json")).size / 1024)} KB)`);
}

buildSydney();
buildBrisbane();
