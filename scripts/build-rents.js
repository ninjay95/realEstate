// Builds site/data/<city>/rents.json — real median weekly rents and the gross
// rental yield they imply, PER DWELLING CLASS (houses and units), matched
// against that same class's median sale price from market.json.
//
// Sydney   — NSW Fair Trading rental bond lodgements. Dwelling type (F) Flat or
//            unit maps to units, (H) House to houses; (T) terrace/townhouse and
//            (O) other are excluded because they straddle both sale classes.
//            Rents are only published at POSTCODE level, so a suburb inherits
//            the median of the postcode(s) its sales sit in.
//            Run scripts/fetch-nsw-rents.sh first.
// Brisbane — QGSO Housing Profiles median rents per SA2, derived by Queensland
//            Treasury from Residential Tenancies Authority bond lodgements.
//            1/2-bedroom flat-unit categories map to units, 3/4-bedroom house
//            categories to houses, combined weighted by lodgement count.
//            Run scripts/fetch-rents-brisbane.js first.
//
// Gross yield = median weekly rent x 52 / median sale price for the same class.
//
// Usage: node scripts/build-rents.js

const fs = require("fs");
const path = require("path");
const { readSheet } = require("./lib/xlsx-lite");

const MIN_RENT_SAMPLE = 10;
const RENT_FLOOR = 80;
const RENT_CEILING = 15000;
const CLASSES = ["houses", "units"];

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const dataPath = (city, file) => path.join(__dirname, "..", "site", "data", city, file);
const yieldPct = (weeklyRent, price) =>
  weeklyRent && price ? Number((((weeklyRent * 52) / price) * 100).toFixed(2)) : null;

// ---------------------------------------------------------------- Sydney ----
function buildSydney() {
  const rentsDir = path.join(__dirname, "raw-nsw", "rents");
  if (!fs.existsSync(rentsDir)) {
    console.log("sydney: no bond data (run scripts/fetch-nsw-rents.sh), skipping");
    return;
  }
  const files = fs.readdirSync(rentsDir).filter((f) => /\.xlsx$/i.test(f));
  console.log(`sydney: reading ${files.length} monthly bond files...`);

  const byPostcode = new Map(); // postcode -> { houses: [], units: [], beds: {} }
  let kept = 0, total = 0;
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
      const cls = dwelling === "F" ? "units" : dwelling === "H" ? "houses" : null;
      if (!cls || !/^\d{4}$/.test(postcode)) continue;
      if (!Number.isFinite(rent) || rent < RENT_FLOOR || rent > RENT_CEILING) continue;
      if (!byPostcode.has(postcode)) byPostcode.set(postcode, { houses: [], units: [], beds: {} });
      const bucket = byPostcode.get(postcode);
      bucket[cls].push(rent);
      (bucket.beds[`${cls}:${/^\d+$/.test(beds) ? beds : "?"}`] ??= []).push(rent);
      kept++;
    }
  }
  console.log(`sydney: ${kept} usable lodgements of ${total} rows`);

  const market = JSON.parse(fs.readFileSync(dataPath("sydney", "market.json"), "utf8"));
  const suburbs = {};
  const withYield = { houses: 0, units: 0 };

  for (const [name, m] of Object.entries(market.suburbs)) {
    const pcs = m.postcodes || [];
    const entry = {};
    for (const cls of CLASSES) {
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
      // Only yield against a reasonably current price — a suburb that last
      // traded enough of this class a year ago would otherwise divide today's
      // rent by a year-old median.
      const classRec = m[cls];
      const price = classRec && classRec.medianIsCurrent ? classRec.medianValue : null;
      const gross = yieldPct(weekly, price);
      if (gross != null) withYield[cls]++;
      entry[cls] = {
        medianWeeklyRent: weekly,
        rentSample: pool.length,
        rentScope: pcs.length ? `postcode ${pcs.slice(0, 3).join(", ")}` : null,
        priceUsed: price,
        grossYieldPct: gross,
        byBedrooms: Object.fromEntries(
          Object.entries(bedPool)
            .filter(([, v]) => v.length >= MIN_RENT_SAMPLE)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([k, v]) => [k, { median: median(v), count: v.length }])
        ),
      };
    }
    suburbs[name] = entry;
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "NSW Fair Trading rental bond lodgements (postcode level)",
    method: `Median weekly rent from ${files.length} months of bond lodgements, split by dwelling type — (F) flat/unit for units, (H) house for houses. Rents are published by postcode, so suburbs sharing a postcode share a rent median. Gross yield = weekly rent x 52 / the median sale price for the same class.`,
    monthsIncluded: files.length,
    classes: CLASSES,
    suburbs,
  };
  fs.writeFileSync(dataPath("sydney", "rents.json"), JSON.stringify(out));
  console.log(
    `sydney: wrote ${Object.keys(suburbs).length} suburbs ` +
    `(houses ${withYield.houses} yields, units ${withYield.units} yields, ` +
    `${Math.round(fs.statSync(dataPath("sydney", "rents.json")).size / 1024)} KB)`
  );
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
  const withYield = { houses: 0, units: 0 };
  let period = null;

  // QGSO publishes these four categories only
  const CLASS_KEYS = { units: ["unit1", "unit2"], houses: ["house3", "house4"] };
  const BED_LABELS = { unit1: "1 bed unit", unit2: "2 bed unit", house3: "3 bed house", house4: "4 bed house" };

  for (const [name, m] of Object.entries(market.suburbs)) {
    const q = raw[name];
    if (q && q.ok) period = period || q.period;
    const entry = {};
    for (const cls of CLASSES) {
      let weekly = null, sample = 0;
      if (q && q.ok) {
        // Lodgement-weighted across the class's bedroom categories, so the rent
        // reflects the same spread of stock the sale median covers.
        let num = 0, den = 0;
        for (const k of CLASS_KEYS[cls]) {
          const rent = q.medianRent[k], n = q.lodgements[k];
          if (rent && n && n >= MIN_RENT_SAMPLE) { num += rent * n; den += n; }
        }
        if (den > 0) { weekly = Math.round(num / den); sample = den; }
      }
      // Only yield against a CURRENT price. Where QVAS published no median for
      // this class, market.json falls back to the ABS FY2024 figure, and
      // dividing today's rent by a two-year-old price overstates the yield.
      const classRec = m[cls];
      const price = classRec && classRec.medianIsCurrent ? classRec.medianValue : null;
      const gross = yieldPct(weekly, price);
      if (gross != null) withYield[cls]++;
      entry[cls] = {
        medianWeeklyRent: weekly,
        rentSample: sample,
        rentScope: q && q.ok ? "SA2" : null,
        priceUsed: price,
        grossYieldPct: gross,
        byBedrooms: q && q.ok
          ? Object.fromEntries(
              CLASS_KEYS[cls]
                .filter((k) => q.medianRent[k])
                .map((k) => [BED_LABELS[k], { median: q.medianRent[k], count: q.lodgements[k] }])
            )
          : {},
      };
    }
    suburbs[name] = entry;
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "Residential Tenancies Authority bond lodgements via QGSO Housing Profiles (SA2 level)",
    method: `Median weekly rent for ${period || "the latest 12-month period"}, combining the published bedroom categories for each dwelling class weighted by lodgement count. Gross yield = weekly rent x 52 / the median sale price for the same class.`,
    period,
    classes: CLASSES,
    suburbs,
  };
  fs.writeFileSync(dataPath("brisbane", "rents.json"), JSON.stringify(out));
  console.log(
    `brisbane: wrote ${Object.keys(suburbs).length} SA2s ` +
    `(houses ${withYield.houses} yields, units ${withYield.units} yields, ` +
    `${Math.round(fs.statSync(dataPath("brisbane", "rents.json")).size / 1024)} KB)`
  );
}

// ------------------------------------------------------------- Melbourne ----
// The Victorian Rental Report publishes by suburb GROUP ("Collingwood-
// Abbotsford"), one sheet per dwelling size, with (count, median) pairs across
// quarters. A group's rent applies to each suburb named in it — the same
// coarser-than-suburb caveat as Sydney's postcode rents, surfaced as the scope.
function parseVicRentSheet(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!row || typeof row[0] !== "string" || !row[0].trim()) continue;
    // the first row of each region carries the region in col 0 and the group
    // in col 1; every other row has the group in col 0
    const secondIsText = typeof row[1] === "string" && row[1].trim() && !Number.isFinite(Number(row[1]));
    const nameIdx = secondIsText ? 1 : 0;
    const group = String(row[nameIdx]).trim();
    if (group.length < 3) continue;

    let last = null;
    for (let c = nameIdx + 1; c + 1 < row.length; c += 2) {
      const count = Number(String(row[c] ?? "").replace(/[^0-9.]/g, ""));
      const median = Number(String(row[c + 1] ?? "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(count) && Number.isFinite(median) && count > 0 && median > 0) {
        last = { count, median };
      }
    }
    if (last) out.set(group, last);
  }
  return out;
}

function buildMelbourne() {
  const rentsDir = path.join(__dirname, "raw-melbourne", "rents");
  if (!fs.existsSync(rentsDir)) {
    console.log("melbourne: no rent data (run scripts/fetch-melbourne-data.js), skipping");
    return;
  }
  const files = fs.readdirSync(rentsDir).filter((f) => /\.xlsx$/i.test(f)).sort();
  if (!files.length) { console.log("melbourne: no rent workbooks, skipping"); return; }
  const file = path.join(rentsDir, files[files.length - 1]);

  const SHEET_CLASS = {
    "1 bedroom flat": "units", "2 bedroom flat": "units", "3 bedroom flat": "units",
    "2 bedroom house": "houses", "3 bedroom house": "houses", "4 bedroom house": "houses",
  };
  const { sheetNames } = readSheet(file, 0);
  const perSheet = [];
  sheetNames.forEach((sheetName, i) => {
    const cls = SHEET_CLASS[sheetName.trim().toLowerCase()];
    if (!cls) return;
    const { rows } = readSheet(file, i);
    perSheet.push({ label: sheetName.trim(), cls, data: parseVicRentSheet(rows) });
  });

  const market = JSON.parse(fs.readFileSync(dataPath("melbourne", "market.json"), "utf8"));
  const upperToName = new Map(Object.keys(market.suburbs).map((n) => [n.toUpperCase(), n]));

  // The rental report writes compass points as a prefix ("East St Kilda")
  // where the locality register puts them last ("St Kilda East"), so try both.
  const DIRECTION = /^(north|south|east|west|upper|lower)\s+(.+)$/i;
  const aliases = (part) => {
    const out = [part];
    const m = part.match(DIRECTION);
    if (m) out.push(`${m[2]} ${m[1]}`);
    const words = part.split(/\s+/);
    if (words.length > 1 && DIRECTION.test(`${words[words.length - 1]} x`)) {
      out.push(`${words[words.length - 1]} ${words.slice(0, -1).join(" ")}`);
    }
    return out;
  };

  // group -> the suburbs it covers
  const groupSuburbs = new Map();
  for (const { data } of perSheet) {
    for (const group of data.keys()) {
      if (groupSuburbs.has(group)) continue;
      if (/^[\d\s.]+$/.test(group)) { groupSuburbs.set(group, []); continue; } // stray numeric rows
      const parts = group.split("-").map((p) => p.trim()).filter(Boolean);
      const matched = [group, ...parts]
        .flatMap(aliases)
        .map((p) => upperToName.get(p.toUpperCase()))
        .filter(Boolean);
      groupSuburbs.set(group, [...new Set(matched)]);
    }
  }

  const suburbs = {};
  const withYield = { houses: 0, units: 0 };
  for (const [name, m] of Object.entries(market.suburbs)) {
    const entry = {};
    for (const cls of CLASSES) {
      // every sheet of this class whose group covers this suburb
      const hits = [];
      for (const sheet of perSheet) {
        if (sheet.cls !== cls) continue;
        for (const [group, value] of sheet.data) {
          if (!groupSuburbs.get(group)?.includes(name)) continue;
          if (value.count >= MIN_RENT_SAMPLE) hits.push({ ...value, label: sheet.label, group });
        }
      }
      let weekly = null, sample = 0, scope = null;
      if (hits.length) {
        const num = hits.reduce((s, h) => s + h.median * h.count, 0);
        const den = hits.reduce((s, h) => s + h.count, 0);
        weekly = Math.round(num / den);
        sample = den;
        scope = `suburb group ${hits[0].group}`;
      }
      const classRec = m[cls];
      const price = classRec && classRec.medianIsCurrent ? classRec.medianValue : null;
      const gross = yieldPct(weekly, price);
      if (gross != null) withYield[cls]++;
      entry[cls] = {
        medianWeeklyRent: weekly,
        rentSample: sample,
        rentScope: scope,
        priceUsed: price,
        grossYieldPct: gross,
        byBedrooms: Object.fromEntries(
          hits.map((h) => [h.label, { median: h.median, count: h.count }])
        ),
      };
    }
    suburbs[name] = entry;
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "Victorian Rental Report, DFFH (Residential Tenancies Bond Authority data)",
    method: "Moving annual median weekly rent, published by suburb group and dwelling size. Sizes are combined into houses and units weighted by bond count. Suburbs sharing a group share a rent median. Gross yield = weekly rent x 52 / the median sale price for the same class.",
    classes: CLASSES,
    suburbs,
  };
  fs.writeFileSync(dataPath("melbourne", "rents.json"), JSON.stringify(out));
  console.log(
    `melbourne: wrote ${Object.keys(suburbs).length} suburbs ` +
    `(houses ${withYield.houses} yields, units ${withYield.units} yields, ` +
    `${Math.round(fs.statSync(dataPath("melbourne", "rents.json")).size / 1024)} KB)`
  );
}

buildSydney();
buildBrisbane();
buildMelbourne();
