// Scores every suburb/SA2 on real amenity access using the OSM points from
// scripts/fetch-amenities.js, and writes site/data/<city>/amenities.json.
//
// Per suburb:
//   transit:  stations inside the boundary, else distance to the nearest
//   schools:  schools inside the boundary, else distance to the nearest
//   shopping: nearest shopping centre (mall) + supermarkets inside
//
// Each category is scored 0-10 with simple documented heuristics; the total
// is their average. Scores are heuristic conveniences over real locations —
// the underlying facts (names, distances, counts) are shown in the UI.
//
// Usage: node scripts/build-amenities.js

const fs = require("fs");
const path = require("path");

const CITIES = ["sydney", "brisbane", "melbourne"];

// --- geometry helpers -----------------------------------------------------
const KM_PER_DEG_LAT = 111.2;
function kmBetween(a, b) {
  const kmLon = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180)) * 111.32;
  const dx = (a[0] - b[0]) * kmLon;
  const dy = (a[1] - b[1]) * KM_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInFeature(pt, geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    if (pointInRing(pt, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (pointInRing(pt, poly[h])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}

// --- classify OSM elements ------------------------------------------------
function classify(el) {
  const t = el.tags || {};
  // depots/yards are tagged like stations but serve no passengers
  if (/depot|yard|workshop|maintenance/i.test(t.name || "")) return null;
  if (t.railway === "station" || t.public_transport === "station" || t.amenity === "bus_station" || t.amenity === "ferry_terminal") {
    let kind = "rail";
    if (t.amenity === "ferry_terminal") kind = "ferry";
    else if (t.amenity === "bus_station" || t.bus === "yes") kind = "bus";
    else if (t.station === "light_rail" || t.railway === "light_rail") kind = "light rail";
    else if (t.station === "subway") kind = "metro";
    return { cat: "station", kind };
  }
  if (t.amenity === "school") return { cat: "school" };
  if (t.shop === "mall") return { cat: "mall" };
  if (t.shop === "supermarket") return { cat: "supermarket" };
  return null;
}

function extractPoints(raw) {
  const pts = { station: [], school: [], mall: [], supermarket: [] };
  for (const el of raw.elements) {
    const cls = classify(el);
    if (!cls) continue;
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon == null) continue;
    pts[cls.cat].push({ pt: [lon, lat], name: (el.tags && el.tags.name) || null, kind: cls.kind });
  }
  // dedupe same-named points within ~400 m (stations mapped as node + area)
  for (const cat of Object.keys(pts)) {
    const kept = [];
    for (const p of pts[cat]) {
      if (p.name && kept.some((k) => k.name === p.name && kmBetween(k.pt, p.pt) < 0.4)) continue;
      kept.push(p);
    }
    pts[cat] = kept;
  }
  return pts;
}

// --- scoring heuristics (0-10) -------------------------------------------
const distScore = (km, steps) => {
  for (const [max, score] of steps) if (km <= max) return score;
  return 0;
};

function scoreSuburb(feat, pts) {
  const centroid = feat.properties.centroid;
  const geom = feat.geometry;

  const within = (cat) => pts[cat].filter((p) => pointInFeature(p.pt, geom));
  const nearest = (cat) => {
    let best = null;
    for (const p of pts[cat]) {
      const d = kmBetween(centroid, p.pt);
      if (!best || d < best.distKm) best = { name: p.name, kind: p.kind, distKm: d };
    }
    return best;
  };

  const stIn = within("station");
  const stNear = nearest("station");
  const transit = stIn.length >= 2 ? 10 : stIn.length === 1 ? 8.5
    : stNear ? distScore(stNear.distKm, [[0.8, 7], [1.5, 5.5], [2.5, 4], [4, 2]]) : 0;

  const schIn = within("school");
  const schNear = nearest("school");
  const schools = schIn.length >= 3 ? 10 : schIn.length === 2 ? 8 : schIn.length === 1 ? 6
    : schNear ? distScore(schNear.distKm, [[1, 4], [2, 2]]) : 0;

  const mallIn = within("mall");
  const mallNear = nearest("mall");
  const mallScore = mallIn.length ? 10
    : mallNear ? distScore(mallNear.distKm, [[1, 8], [2.5, 6], [5, 4], [8, 2]]) : 0;
  const superIn = within("supermarket");
  const shopping = Number((0.7 * mallScore + 0.3 * Math.min(superIn.length, 3) * (10 / 3)).toFixed(1));

  const total = Number(((transit + schools + shopping) / 3).toFixed(1));
  const near = (n) => (n ? { name: n.name, kind: n.kind, distKm: Number(n.distKm.toFixed(1)) } : null);
  return {
    scores: { transit: Number(transit.toFixed(1)), schools: Number(schools.toFixed(1)), shopping, total },
    facts: {
      stationsIn: stIn.length,
      nearestStation: near(stIn[0] ? { ...stIn[0], distKm: 0 } : stNear),
      schoolsIn: schIn.length,
      nearestMall: near(mallIn[0] ? { ...mallIn[0], distKm: 0 } : mallNear),
      supermarketsIn: superIn.length,
    },
  };
}

for (const city of CITIES) {
  const rawPath = path.join(__dirname, "raw-amenities", `${city}.json`);
  if (!fs.existsSync(rawPath)) {
    console.log(`${city}: no raw data (run fetch-amenities.js first), skipping`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  const geo = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "site", "data", city, "suburbs.geojson"), "utf8"));
  const pts = extractPoints(raw);
  const suburbs = {};
  for (const feat of geo.features) suburbs[feat.properties.name] = scoreSuburb(feat, pts);
  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "OpenStreetMap (© OpenStreetMap contributors, ODbL) via Overpass API",
    counts: Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, v.length])),
    suburbs,
  };
  const outPath = path.join(__dirname, "..", "site", "data", city, "amenities.json");
  fs.writeFileSync(outPath, JSON.stringify(out));
  const totals = Object.values(suburbs).map((s) => s.scores.total);
  console.log(`${city}: ${Object.keys(suburbs).length} suburbs scored (points: ${JSON.stringify(out.counts)}), avg total ${(totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1)}`);
}
