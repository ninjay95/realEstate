// Fetches everything needed for the Brisbane map into scripts/raw-brisbane/:
//
//  1. Greater Brisbane SA2 boundaries (ABS ASGS 2021, official ArcGIS service)
//     -> site/data/brisbane/suburbs.geojson
//  2. ABS "Data by region" annual medians per SA2 (established houses +
//     attached dwellings, year ended 30 June) -> raw-brisbane/abs-houses.csv
//  3. QGSO Housing Profiles residential dwelling sales per SA2 (12-month
//     median + counts from the QVAS database, CC BY 4.0)
//     -> raw-brisbane/qgso-sales.json   (incremental; safe to re-run)
//
// Usage: node scripts/fetch-brisbane-data.js

const fs = require("fs");
const path = require("path");

const RAW = path.join(__dirname, "raw-brisbane");
const OUTGEO = path.join(__dirname, "..", "site", "data", "brisbane", "suburbs.geojson");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(path.dirname(OUTGEO), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ringCentroidArea(ring) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    const f = x1 * y2 - x2 * y1;
    area += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) return { area: 0, cx: ring[0][0], cy: ring[0][1] };
  return { area, cx: cx / (6 * area), cy: cy / (6 * area) };
}
function centroidOf(polys) {
  let t = 0, cx = 0, cy = 0;
  for (const poly of polys) {
    const { area, cx: x, cy: y } = ringCentroidArea(poly[0]);
    const a = Math.abs(area);
    t += a; cx += x * a; cy += y * a;
  }
  if (t === 0) return [polys[0][0][0][0], polys[0][0][0][1]];
  return [Number((cx / t).toFixed(5)), Number((cy / t).toFixed(5))];
}

async function fetchBoundaries() {
  if (fs.existsSync(OUTGEO)) {
    console.log("boundaries: already present, skipping");
    return JSON.parse(fs.readFileSync(OUTGEO, "utf8"));
  }
  console.log("boundaries: querying ABS ArcGIS...");
  const params = new URLSearchParams({
    where: "gccsa_name_2021='Greater Brisbane'",
    outFields: "sa2_code_2021,sa2_name_2021",
    returnGeometry: "true",
    maxAllowableOffset: "0.0004",
    geometryPrecision: "4",
    outSR: "4326",
    f: "geojson",
  });
  const url = `https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SA2/FeatureServer/0/query?${params}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`ABS ArcGIS ${res.status}`);
  const geo = await res.json();
  const features = geo.features
    .filter((f) => f.geometry)
    .map((f) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      return {
        type: "Feature",
        properties: {
          name: f.properties.sa2_name_2021,
          code: String(f.properties.sa2_code_2021),
          centroid: centroidOf(polys),
        },
        geometry: f.geometry,
      };
    })
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  const out = { type: "FeatureCollection", features };
  fs.writeFileSync(OUTGEO, JSON.stringify(out));
  console.log(`boundaries: wrote ${features.length} SA2s (${Math.round(fs.statSync(OUTGEO).size / 1024)} KB)`);
  return out;
}

async function fetchAbs(codes) {
  const outPath = path.join(RAW, "abs-houses.csv");
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
    console.log("ABS medians: already present, skipping");
    return;
  }
  console.log(`ABS medians: querying ${codes.length} SA2s...`);
  const rows = [];
  for (let i = 0; i < codes.length; i += 40) {
    const chunk = codes.slice(i, i + 40);
    const url = `https://data.api.abs.gov.au/rest/data/ABS_REGIONAL_ASGS2021/HOUSES_2+HOUSES_3+HOUSES_4+HOUSES_5.SA2.${chunk.join("+")}.A?startPeriod=2018`;
    const res = await fetch(url, { headers: { Accept: "text/csv", "User-Agent": UA } });
    const body = await res.text();
    if (!res.ok || body.startsWith("NoRecords")) {
      console.log(`  chunk ${i / 40}: ${res.status} ${body.slice(0, 60)}`);
      continue;
    }
    const lines = body.trim().split("\n");
    rows.push(...(rows.length ? lines.slice(1) : lines));
    process.stdout.write(`  chunk ${i / 40 + 1}/${Math.ceil(codes.length / 40)}\r`);
    await sleep(400);
  }
  fs.writeFileSync(outPath, rows.join("\n"));
  console.log(`\nABS medians: wrote ${rows.length - 1} observations`);
}

function parseQgsoReport(html) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#xa0;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const period = (text.match(/12 months ending (\d+ \w+ \d{4})/) || [])[1] || null;
  const m = text.match(/— \$ — (.*?) Queensland [\d,]+ [\d,]+/);
  if (!m) return { period, ok: false };
  const tokens = m[1].trim().split(" ");
  // last 6 tokens are the numbers (counts + medians); the rest is the region name
  if (tokens.length < 7) return { period, ok: false };
  const nums = tokens.slice(-6).map((t) => {
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null; // "n.a." / ". ." -> null
  });
  return {
    period,
    ok: true,
    detachedCount: nums[0],
    attachedCount: nums[1],
    totalCount: nums[2],
    detachedMedian: nums[3],
    attachedMedian: nums[4],
    totalMedian: nums[5],
  };
}

async function fetchQgso(names) {
  const idMap = JSON.parse(fs.readFileSync(path.join(__dirname, "qgso-sa2-ids.json"), "utf8"));
  const outPath = path.join(RAW, "qgso-sales.json");
  const store = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
  const todo = names.filter((n) => !(n in store));
  console.log(`QGSO profiles: ${names.length} SA2s, ${todo.length} to fetch`);
  let done = 0, misses = 0;
  for (const name of todo) {
    const id = idMap[name];
    if (!id) {
      store[name] = { ok: false, reason: "no QGSO id" };
      misses++;
      continue;
    }
    const body = new URLSearchParams({
      p_reg: id, p_comp_regtype: "S", p_comp_reg: "", p_topic_group: "ALL",
      p_rep_date: "", p_ref: "", p_maploaded_1: "Y", p_maploaded_2: "N",
      p_flashversion: "n.a.", p_reptyp: "RES", p_regtype: "SA2_21",
      p_user_region_name: "", p_comp_reg_list: "S", p_user_region_name_comp: "",
      p_topic_group_all: "ALL", p_topic: "HOUSESALE", p_format: "html",
    });
    try {
      const res = await fetch("https://statistics.qgso.qld.gov.au/hpw/request-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Referer: "https://statistics.qgso.qld.gov.au/hpw/profiles",
        },
        body: body.toString(),
        redirect: "follow",
      });
      const html = await res.text();
      const parsed = parseQgsoReport(html);
      store[name] = parsed;
      if (!parsed.ok) misses++;
    } catch (e) {
      store[name] = { ok: false, reason: String(e).slice(0, 120) };
      misses++;
    }
    done++;
    if (done % 10 === 0) {
      fs.writeFileSync(outPath, JSON.stringify(store));
      process.stdout.write(`  ${done}/${todo.length} (${misses} misses)\r`);
    }
    await sleep(1500);
  }
  fs.writeFileSync(outPath, JSON.stringify(store));
  console.log(`\nQGSO profiles: done, ${misses} misses of ${todo.length}`);
}

(async () => {
  const geo = await fetchBoundaries();
  const codes = geo.features.map((f) => f.properties.code);
  const names = geo.features.map((f) => f.properties.name);
  await fetchAbs(codes);
  await fetchQgso(names);
  console.log("All Brisbane raw data fetched.");
})().catch((e) => { console.error(e); process.exit(1); });
