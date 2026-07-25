// Filters the raw NSW locality boundaries down to the Sydney metro area,
// merges same-named localities into MultiPolygons, trims coordinate precision
// and writes site/data/suburbs.geojson with name + centroid properties.
//
// Input:  scripts/nsw-suburbs-raw.geojson  (suburb-2-nsw.geojson from
//         github.com/tonywr71/GeoJson-Data — PSMA administrative boundaries)
// Usage:  node scripts/build-suburbs.js

const fs = require("fs");
const path = require("path");

const BBOX = { west: 150.88, east: 151.33, south: -34.09, north: -33.62 };
const PRECISION = 4; // ~11 m — plenty for a choropleth

const rawPath = path.join(__dirname, "nsw-suburbs-raw.geojson");
const outPath = path.join(__dirname, "..", "site", "data", "suburbs.geojson");

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));

function ringCentroidArea(ring) {
  // Shoelace centroid of a single ring (lon/lat treated as planar — fine at city scale)
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const f = x1 * y2 - x2 * y1;
    area += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) return { area: 0, cx: ring[0][0], cy: ring[0][1] };
  return { area, cx: cx / (6 * area), cy: cy / (6 * area) };
}

function featureCentroid(polygons) {
  // Area-weighted centroid over outer rings of all polygons
  let totalArea = 0, cx = 0, cy = 0;
  for (const poly of polygons) {
    const { area, cx: x, cy: y } = ringCentroidArea(poly[0]);
    const a = Math.abs(area);
    totalArea += a;
    cx += x * a;
    cy += y * a;
  }
  if (totalArea === 0) return { lng: polygons[0][0][0][0], lat: polygons[0][0][0][1], area: 0 };
  return { lng: cx / totalArea, lat: cy / totalArea, area: totalArea };
}

function roundCoords(coords) {
  const m = 10 ** PRECISION;
  return coords.map((ring) => ring.map(([x, y]) => [Math.round(x * m) / m, Math.round(y * m) / m]));
}

const byName = new Map();
for (const f of raw.features) {
  const name = f.properties.nsw_loca_2;
  if (!name || f.geometry == null) continue;
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates]
    : f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [];
  if (polys.length === 0) continue;
  const c = featureCentroid(polys);
  if (c.lng < BBOX.west || c.lng > BBOX.east || c.lat < BBOX.south || c.lat > BBOX.north) continue;
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(...polys);
}

const features = [];
for (const [name, polys] of byName) {
  const c = featureCentroid(polys);
  const title = name
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  features.push({
    type: "Feature",
    properties: {
      name: title,
      centroid: [Number(c.lng.toFixed(5)), Number(c.lat.toFixed(5))],
      areaDeg2: Number(c.area.toFixed(8)),
    },
    geometry: polys.length === 1
      ? { type: "Polygon", coordinates: roundCoords(polys[0]) }
      : { type: "MultiPolygon", coordinates: polys.map(roundCoords) },
  });
}

features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ type: "FeatureCollection", features }));
const kb = Math.round(fs.statSync(outPath).size / 1024);
console.log(`Wrote ${features.length} suburbs (${kb} KB) -> ${outPath}`);
