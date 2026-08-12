// Fetches real amenity locations from OpenStreetMap (Overpass API) for each
// city's bounding box (derived from the committed suburb boundaries):
//
//   - transit stations: railway/public_transport stations, bus stations
//     (busways), ferry terminals
//   - schools (amenity=school)
//   - shopping centres (shop=mall)
//   - supermarkets (shop=supermarket)
//
// Output: scripts/raw-amenities/<city>.json  (raw Overpass elements)
// Data © OpenStreetMap contributors, ODbL.
//
// Usage: node scripts/fetch-amenities.js

const fs = require("fs");
const path = require("path");

const RAW = path.join(__dirname, "raw-amenities");
fs.mkdirSync(RAW, { recursive: true });
const CITIES = ["sydney", "brisbane", "melbourne"];
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = "suburb-opportunity-map/0.1 (personal project; github.com/ninjay95/realEstate)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bboxOf(geojsonPath) {
  const geo = JSON.parse(fs.readFileSync(geojsonPath, "utf8"));
  let w = 180, s = 90, e = -180, n = -90;
  const scan = (coords) => {
    if (typeof coords[0] === "number") {
      w = Math.min(w, coords[0]); e = Math.max(e, coords[0]);
      s = Math.min(s, coords[1]); n = Math.max(n, coords[1]);
    } else coords.forEach(scan);
  };
  geo.features.forEach((f) => scan(f.geometry.coordinates));
  return { s, w, n, e };
}

async function fetchCity(city) {
  const out = path.join(RAW, `${city}.json`);
  if (fs.existsSync(out) && fs.statSync(out).size > 100000) {
    console.log(`${city}: already fetched, skipping`);
    return;
  }
  const { s, w, n, e } = bboxOf(path.join(__dirname, "..", "site", "data", city, "suburbs.geojson"));
  const bbox = `${s},${w},${n},${e}`;
  console.log(`${city}: bbox ${bbox}`);
  // one query per selector — the combined query 504s on public mirrors
  const selectors = [
    '"railway"="station"',
    '"public_transport"="station"',
    '"amenity"="bus_station"',
    '"amenity"="ferry_terminal"',
    '"amenity"="school"',
    '"shop"="mall"',
    '"shop"="supermarket"',
  ];
  // per-selector cache so a failed category doesn't lose the others
  const cachePath = path.join(RAW, `${city}-partial.json`);
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
  for (const sel of selectors) {
    if (cache[sel]) {
      console.log(`  ${sel}: cached (${cache[sel].length})`);
      continue;
    }
    const query = `[out:json][timeout:120];nwr[${sel}](${bbox});out center tags;`;
    let data = null, lastErr = null;
    for (const mirror of MIRRORS) {
      for (let attempt = 1; attempt <= 2 && !data; attempt++) {
        try {
          const res = await fetch(mirror, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Accept: "application/json" },
            body: "data=" + encodeURIComponent(query),
          });
          if (!res.ok) throw new Error(`Overpass ${res.status}`);
          data = await res.json();
        } catch (err) {
          lastErr = err;
          await sleep(5000);
        }
      }
      if (data) break;
    }
    if (!data) throw new Error(`${city} ${sel}: ${lastErr}`);
    cache[sel] = data.elements;
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    console.log(`  ${sel}: ${data.elements.length} elements`);
    await sleep(3000);
  }
  // merge cached categories, dedupe by element id
  const elements = [];
  const seenIds = new Set();
  for (const sel of selectors) {
    for (const el of cache[sel]) {
      const key = `${el.type}/${el.id}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      elements.push(el);
    }
  }
  fs.writeFileSync(out, JSON.stringify({ elements }));
  fs.rmSync(cachePath, { force: true });
  console.log(`${city}: ${elements.length} elements total (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

(async () => {
  for (const city of CITIES) {
    await fetchCity(city);
    await new Promise((r) => setTimeout(r, 5000)); // be polite between big queries
  }
})().catch((err) => { console.error(err); process.exit(1); });
