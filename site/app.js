/* Suburb Opportunity Map
 *
 * Four views over public property records:
 *   trend      — median price movement (%/month)
 *   yield      — gross rental yield from bond lodgements
 *   amenities  — transit / schools / shopping access from OpenStreetMap
 *   combined   — 0-100 opportunity rating blending the three
 *
 * Sydney prices come from NSW Valuer General bulk sales (individual records);
 * Brisbane from QGSO/QVAS + ABS Data by region. All data is pre-built into
 * site/data/<city>/*.json — this page is static and needs no backend.
 */

"use strict";

const CITIES = {
  sydney: { label: "Sydney", dir: "data/sydney", center: [-33.85, 151.08], zoom: 11, areaWord: "suburbs" },
  brisbane: { label: "Brisbane", dir: "data/brisbane", center: [-27.47, 153.02], zoom: 10, areaWord: "SA2 areas" },
};

/* --- colour scales -------------------------------------------------------
 * Validated palettes: trend is diverging (green = falling, red = rising) with a
 * neutral midpoint; the others are single-hue sequential ramps. The value
 * labels on the map and the swatches in the list are the colour-independent
 * secondary encoding.
 */
const TREND_BUCKETS = [
  { max: -1.5, color: "#2e7d32", label: "Falling 1.5%/mo or more" },
  { max: -0.75, color: "#5aab5e", label: "Falling 0.75–1.5%/mo" },
  { max: -0.25, color: "#b7dfb9", label: "Easing 0.25–0.75%/mo" },
  { max: 0.25, color: "#cfcdc6", label: "Flat (within ±0.25%/mo)" },
  { max: 0.75, color: "#f2b8aa", label: "Rising 0.25–0.75%/mo" },
  { max: 1.5, color: "#e06a4a", label: "Rising 0.75–1.5%/mo" },
  { max: Infinity, color: "#b02e23", label: "Rising 1.5%/mo or more" },
];
const YIELD_BUCKETS = [
  { max: 2.5, color: "#fde3d3", label: "Under 2.5%" },
  { max: 3, color: "#fac4a5", label: "2.5–3%" },
  { max: 3.5, color: "#f59d6b", label: "3–3.5%" },
  { max: 4.5, color: "#eb6834", label: "3.5–4.5%" },
  { max: Infinity, color: "#b94a1c", label: "4.5% and above" },
];
const AMENITY_BUCKETS = [
  { max: 2, color: "#cde2fb", label: "0–2 · few amenities" },
  { max: 4, color: "#9ec5f4", label: "2–4" },
  { max: 6, color: "#5598e7", label: "4–6" },
  { max: 8, color: "#2a78d6", label: "6–8" },
  { max: Infinity, color: "#1c5cab", label: "8–10 · best served" },
];
const RATING_BUCKETS = [
  { max: 20, color: "#e7f0e7", label: "0–20" },
  { max: 40, color: "#c4e0c6", label: "20–40" },
  { max: 55, color: "#8cc790", label: "40–55" },
  { max: 70, color: "#5aab5e", label: "55–70" },
  { max: 85, color: "#3c8f42", label: "70–85" },
  { max: Infinity, color: "#1e6323", label: "85–100 · strongest" },
];
const NO_DATA_COLOR = "#b8b6b0";

const bucketsFor = (mode) =>
  mode === "trend" ? TREND_BUCKETS
    : mode === "yield" ? YIELD_BUCKETS
      : mode === "amenities" ? AMENITY_BUCKETS : RATING_BUCKETS;

function bucketColor(buckets, v) {
  for (const b of buckets) if (v < b.max || b.max === Infinity) return b.color;
  return buckets[buckets.length - 1].color;
}

/* --- formatting ---------------------------------------------------------- */

const fmtMoney = (v) =>
  v == null ? "—" : v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;

const fmtRate = (pct) => {
  if (pct == null) return { cls: "is-flat", text: "no data" };
  if (pct <= -0.25) return { cls: "is-down", text: `▼ ${Math.abs(pct).toFixed(1)}%` };
  if (pct >= 0.25) return { cls: "is-up", text: `▲ ${pct.toFixed(1)}%` };
  return { cls: "is-flat", text: "flat" };
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* --- combined rating ----------------------------------------------------
 * 40% price momentum (-2.0%/mo or better = full marks, +0.5%/mo = zero),
 * 30% gross yield (2.0% = zero, 5.5%+ = full marks), 30% amenity access.
 * A missing component drops out and the rest are renormalised; price momentum
 * is required, so an area without a trend has no rating.
 */
const RATING_WEIGHTS = { trend: 0.4, yield: 0.3, amenities: 0.3 };
function combinedScore(stats, am, rent) {
  if (!stats || stats.monthlyChangePct == null) return null;
  const parts = [[RATING_WEIGHTS.trend, Math.max(0, Math.min(1, (-stats.monthlyChangePct + 0.5) / 2.5))]];
  if (rent && rent.grossYieldPct != null) {
    parts.push([RATING_WEIGHTS.yield, Math.max(0, Math.min(1, (rent.grossYieldPct - 2) / 3.5))]);
  }
  if (am) parts.push([RATING_WEIGHTS.amenities, am.scores.total / 10]);
  const weight = parts.reduce((sum, [w]) => sum + w, 0);
  return Math.round((100 * parts.reduce((sum, [w, v]) => sum + w * v, 0)) / weight);
}

/* --- theme --------------------------------------------------------------- */

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const THEME_ORDER = ["system", "light", "dark"];
const THEME_TEXT = { system: "Auto", light: "Light", dark: "Dark" };
let themePref = localStorage.getItem("theme") || "system";
const isDark = () => themePref === "dark" || (themePref === "system" && darkQuery.matches);

function applyTheme() {
  const root = document.documentElement;
  if (themePref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", themePref);
  const btn = document.getElementById("theme-toggle");
  btn.querySelector(".theme-text").textContent = THEME_TEXT[themePref];
  btn.setAttribute("aria-label", `Colour theme: ${themePref === "system" ? "follow system" : themePref}`);
  setTiles();
  if (geoLayer) geoLayer.setStyle(styleFor);
}

/* --- map ----------------------------------------------------------------- */

const map = L.map("map", { zoomControl: true, attributionControl: true })
  .setView(CITIES.sydney.center, CITIES.sydney.zoom);
window.__map = map; // console/debug handle

let tileLayer = null;
function setTiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/${isDark() ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`,
    {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }
  ).addTo(map);
  tileLayer.bringToBack();
}
setTiles();
darkQuery.addEventListener("change", () => { if (themePref === "system") applyTheme(); });

/* --- state --------------------------------------------------------------- */

let currentCity = "sydney";
let currentMode = "trend";
let market = {}, marketMeta = {};
let amenities = {}, amenityMeta = {};
let rents = {}, rentMeta = {};
let currentGeo = null;
let geoLayer = null;
const labelLayer = L.layerGroup();
const suburbIndex = new Map();
let defaultPanelHtml = "";
const panelContent = document.getElementById("panel-content");

function modeValue(name) {
  const entry = suburbIndex.get(name) || { stats: market[name], am: amenities[name], rent: rents[name] };
  const { stats, am, rent } = entry;
  if (currentMode === "trend") {
    if (!stats || stats.monthlyChangePct == null) return null;
    const r = fmtRate(stats.monthlyChangePct);
    return { v: stats.monthlyChangePct, text: r.text + "/mo", cls: r.cls, asc: true };
  }
  if (currentMode === "yield") {
    if (!rent || rent.grossYieldPct == null) return null;
    return { v: rent.grossYieldPct, text: `${rent.grossYieldPct.toFixed(1)}%`, cls: "is-flat", asc: false };
  }
  if (currentMode === "amenities") {
    if (!am) return null;
    return { v: am.scores.total, text: am.scores.total.toFixed(1), cls: "is-flat", asc: false };
  }
  const score = combinedScore(stats, am, rent);
  if (score == null) return null;
  return { v: score, text: String(score), cls: "is-flat", asc: false };
}

const colorFor = (name) => {
  const mv = modeValue(name);
  return mv ? bucketColor(bucketsFor(currentMode), mv.v) : NO_DATA_COLOR;
};

function styleFor(feature) {
  const mv = modeValue(feature.properties.name);
  return {
    fillColor: mv ? bucketColor(bucketsFor(currentMode), mv.v) : NO_DATA_COLOR,
    fillOpacity: mv ? 0.58 : 0.16,
    color: isDark() ? "rgba(238,241,244,0.32)" : "rgba(15,19,23,0.28)",
    weight: 1,
    dashArray: mv ? null : "3 3",
  };
}

const MODE_TITLES = {
  trend: () => `Price trend · ${marketMeta.trendLabel || ""}`,
  yield: () => "Gross rental yield",
  amenities: () => "Amenity access · 0–10",
  combined: () => "Opportunity rating · 0–100",
};
const MODE_HEADINGS = {
  trend: "Fastest-falling medians",
  yield: "Highest gross yields",
  amenities: "Best-served areas",
  combined: "Strongest opportunity ratings",
};
const MODE_HINTS = {
  trend: "Where median prices have dropped most — the cooling end of the market.",
  yield: "Annual rent as a share of the median price, from real bond lodgements.",
  amenities: "Transit, schools and shopping access scored from mapped locations.",
  combined: "Price momentum, rental yield and amenity access, combined.",
};

/* --- loading ------------------------------------------------------------- */

async function loadCity(city) {
  currentCity = city;
  const cfg = CITIES[city];
  document.querySelectorAll("[id^=city-]").forEach((b) => {
    const active = b.id === `city-${city}`;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  document.getElementById("subtitle").textContent = `Loading ${cfg.label}…`;
  panelContent.innerHTML = '<p class="loading">Loading map data…</p>';

  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  labelLayer.clearLayers();
  suburbIndex.clear();

  const optional = (url) =>
    fetch(url).then((r) => (r.ok ? r.json() : { suburbs: {} })).catch(() => ({ suburbs: {} }));
  const [geo, mkt, amen, rnt] = await Promise.all([
    fetch(`${cfg.dir}/suburbs.geojson`).then((r) => r.json()),
    fetch(`${cfg.dir}/market.json`).then((r) => r.json()),
    optional(`${cfg.dir}/amenities.json`),
    optional(`${cfg.dir}/rents.json`),
  ]);
  market = mkt.suburbs; marketMeta = mkt;
  amenities = amen.suburbs || {}; amenityMeta = amen;
  rents = rnt.suburbs || {}; rentMeta = rnt;
  currentGeo = geo;

  document.getElementById("subtitle").textContent =
    `${cfg.label} · ${geo.features.length} ${cfg.areaWord} · public records to ${mkt.generatedAt}`;

  geoLayer = L.geoJSON(geo, {
    style: styleFor,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.name;
      suburbIndex.set(name, {
        layer,
        centroid: feature.properties.centroid,
        stats: market[name],
        am: amenities[name],
        rent: rents[name],
      });
      layer.on({
        mouseover: (e) => { e.target.setStyle({ weight: 2.5, fillOpacity: 0.75 }); e.target.bringToFront(); },
        mouseout: (e) => geoLayer.resetStyle(e.target),
        click: () => flyToSuburb(name),
      });
    },
  }).addTo(map);

  map.setView(cfg.center, cfg.zoom);
  refreshMode();
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("[id^=mode-]").forEach((b) => {
    const active = b.id === `mode-${mode}`;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  refreshMode();
}

function refreshMode() {
  if (!geoLayer) return;
  geoLayer.setStyle(styleFor);
  suburbIndex.forEach((entry, name) => {
    const mv = modeValue(name);
    const price = entry.stats && entry.stats.medianValue ? `${fmtMoney(entry.stats.medianValue)} median` : null;
    const line = [price, mv ? mv.text : "insufficient data"].filter(Boolean).join(" · ");
    entry.layer.unbindTooltip();
    entry.layer.bindTooltip(
      `<strong>${esc(name)}</strong><br><span class="tip-line">${line}</span>`,
      { sticky: true, className: "suburb-tip" }
    );
  });
  buildLabels();
  buildLegend();
  buildRankPanel();
  buildSearch();
  syncLabelVisibility();
}

/* --- map labels ---------------------------------------------------------- */

function buildLabels() {
  labelLayer.clearLayers();
  if (!currentGeo) return;
  for (const f of currentGeo.features) {
    const name = f.properties.name;
    const mv = modeValue(name);
    if (!mv) continue;
    const icon = L.divIcon({
      className: "rate-pill",
      html: `<span class="pill"><span class="pill-name">${esc(name)} </span><span class="pill-value ${mv.cls}">${mv.text}</span></span>`,
      iconSize: [0, 0],
    });
    const [lng, lat] = f.properties.centroid;
    labelLayer.addLayer(L.marker([lat, lng], { icon, interactive: false, keyboard: false }));
  }
}

function syncLabelVisibility() {
  const z = map.getZoom();
  const want = z >= 12;
  const on = map.hasLayer(labelLayer);
  if (want && !on) labelLayer.addTo(map);
  if (!want && on) map.removeLayer(labelLayer);
  document.getElementById("map").classList.toggle("show-names", z >= 14);
}
map.on("zoomend", syncLabelVisibility);

const nameCss = document.createElement("style");
nameCss.textContent = "#map:not(.show-names) .pill-name{display:none}";
document.head.appendChild(nameCss);

/* --- legend -------------------------------------------------------------- */

let legendControl = null;
let legendOpen = null; // null = follow viewport default
function buildLegend() {
  if (legendControl) map.removeControl(legendControl);
  legendControl = L.control({ position: "bottomleft" });
  legendControl.onAdd = () => {
    // Collapsible: open on desktop, folded away on small screens where the map
    // needs the room. The viewer's choice persists across mode switches.
    const wide = window.matchMedia("(min-width: 901px)").matches;
    const open = legendOpen === null ? wide : legendOpen;
    const el = L.DomUtil.create("details", "legend");
    if (open) el.setAttribute("open", "");
    el.innerHTML =
      `<summary class="legend-title">${MODE_TITLES[currentMode]()}</summary>` +
      `<div class="legend-body">` +
      bucketsFor(currentMode)
        .map((b) => `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`)
        .join("") +
      `<div class="legend-row"><span class="legend-swatch" style="background:${NO_DATA_COLOR};opacity:.45"></span>Insufficient data</div>` +
      `<p class="legend-note">${MODE_HINTS[currentMode]}</p></div>`;
    el.addEventListener("toggle", () => { legendOpen = el.open; });
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    return el;
  };
  legendControl.addTo(map);
}

/* --- panel: ranked list -------------------------------------------------- */

function citySummaryHtml() {
  const all = Object.values(market);
  const cooling = all.filter((s) => s.monthlyChangePct != null && s.monthlyChangePct <= -0.25).length;
  const yields = Object.values(rents).map((r) => r.grossYieldPct).filter((v) => v != null);
  const medYield = median(yields);
  const amScores = Object.values(amenities).map((a) => a.scores.total);
  const medAm = median(amScores);
  const medPrice = median(all.map((s) => s.medianValue).filter((v) => v != null));
  const cell = (value, label) =>
    `<div class="summary-cell"><div class="summary-value num">${value}</div><div class="summary-label">${label}</div></div>`;
  return `<div class="summary">
    ${cell(`${cooling}`, "Cooling areas")}
    ${cell(medPrice != null ? fmtMoney(medPrice) : "—", "Median price")}
    ${cell(medYield != null ? `${medYield.toFixed(1)}%` : "—", "Median yield")}
    ${cell(medAm != null ? medAm.toFixed(1) : "—", "Median amenity")}
  </div>`;
}

function provenanceHtml() {
  const rows = [
    ["Prices", marketMeta.source],
    ["Rents", rentMeta.source],
    ["Amenities", amenityMeta.source],
  ].filter(([, v]) => v);
  return `<p class="provenance">${rows.map(([k, v]) => `<b>${k}:</b> ${esc(v)}`).join("<br>")}</p>`;
}

function buildRankPanel() {
  const ranked = [...suburbIndex.keys()]
    .map((name) => ({ name, mv: modeValue(name), entry: suburbIndex.get(name) }))
    .filter((x) => x.mv)
    .sort((a, b) => (a.mv.asc ? a.mv.v - b.mv.v : b.mv.v - a.mv.v))
    .slice(0, 15);

  const rows = ranked
    .map(({ name, mv, entry }) => {
      const meta = currentMode === "trend" && entry.stats && entry.stats.salesInWindow
        ? `${entry.stats.salesInWindow} sales · ${fmtMoney(entry.stats.medianValue)}`
        : currentMode === "yield" && entry.rent
          ? `${entry.rent.rentSample} bonds · $${entry.rent.medianWeeklyRent}/wk`
          : currentMode === "amenities" && entry.am
            ? `${entry.am.facts.stationsIn} stations · ${entry.am.facts.schoolsIn} schools`
            : entry.stats ? fmtMoney(entry.stats.medianValue) : "";
      return `<li><button class="rank-row" data-suburb="${esc(name)}" type="button">
        <span class="rank-swatch" style="background:${colorFor(name)}"></span>
        <span class="rank-body">
          <span class="rank-name">${esc(name)}</span>
          <span class="rank-meta num">${meta}</span>
        </span>
        <span class="rank-value num ${mv.cls}">${mv.text}</span>
      </button></li>`;
    })
    .join("");

  panelContent.innerHTML = `
    <h2 class="panel-heading">${MODE_HEADINGS[currentMode]}</h2>
    <p class="hint">${CITIES[currentCity].label} · ${MODE_HINTS[currentMode]}</p>
    ${citySummaryHtml()}
    <span class="eyebrow">Top 15 · click for detail</span>
    <ol class="rank-list" id="opportunity-list">${rows}</ol>
    ${provenanceHtml()}`;
  defaultPanelHtml = panelContent.innerHTML;
  bindRankRows();
}

function bindRankRows() {
  panelContent.querySelectorAll(".rank-row").forEach((btn) => {
    btn.addEventListener("click", () => flyToSuburb(btn.dataset.suburb));
  });
}

function restoreDefaultPanel() {
  panelContent.innerHTML = defaultPanelHtml;
  bindRankRows();
}

function flyToSuburb(name) {
  const entry = suburbIndex.get(name);
  if (!entry) return;
  // Panel first: a map animation hiccup must never swallow the detail.
  showDetail(name);
  const [lng, lat] = entry.centroid;
  const zoom = Math.max(map.getZoom(), 13);
  try {
    map.flyTo([lat, lng], zoom, { duration: 0.7 });
  } catch {
    map.setView([lat, lng], zoom, { animate: false });
  }
}

/* --- panel: detail ------------------------------------------------------- */

function sparklineSvg(history) {
  if (!history || history.length < 2) return '<p class="hint hint-quiet">Not enough history to chart.</p>';
  const w = 320, h = 76, pad = 5;
  const values = history.map((p) => p.median);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (w - pad * 2),
    h - pad - ((v - min) / span) * (h - pad * 2),
  ]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;
  const [ex, ey] = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Median price history" preserveAspectRatio="none">
    <path d="${area}" fill="var(--accent)" opacity="0.10" />
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.25" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5" />
  </svg>`;
}

function rentSectionHtml(rent) {
  if (!rent || rent.medianWeeklyRent == null) {
    return `<span class="eyebrow">Rent &amp; yield</span>
      <p class="hint hint-quiet">Too few bond lodgements here to publish a rent median.</p>`;
  }
  const beds = Object.entries(rent.byBedrooms || {});
  const bedRows = beds
    .map(([k, v]) => `<tr><td>${/^\d+$/.test(k) ? `${k} bedroom` : esc(k)}</td><td class="right num">${v.count}</td><td class="right num strong">$${v.median}</td></tr>`)
    .join("");
  return `<span class="eyebrow">Rent &amp; yield · ${esc(rent.rentClass)}</span>
    <div class="metrics">
      <div class="metric"><div class="metric-label">Median rent</div><div class="metric-value num">$${rent.medianWeeklyRent}<span class="unit">/wk</span></div></div>
      <div class="metric"><div class="metric-label">Gross yield</div><div class="metric-value num">${rent.grossYieldPct != null ? rent.grossYieldPct + "%" : "—"}</div></div>
      <div class="metric"><div class="metric-label">Bonds</div><div class="metric-value num">${rent.rentSample}</div></div>
    </div>
    <p class="hint hint-quiet">Measured at ${esc(rent.rentScope || "area")} level${rent.priceUsed ? `, against the ${esc(rent.rentClass)} median of ${fmtMoney(rent.priceUsed)}` : ""}. Gross — before strata, rates and vacancy.</p>
    ${bedRows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Size</th><th class="right">Bonds</th><th class="right">Rent/wk</th></tr></thead><tbody>${bedRows}</tbody></table></div>` : ""}`;
}

function amenitySectionHtml(am) {
  if (!am) return "";
  const { scores: sc, facts: f } = am;
  const score = (label, v) => `<div class="score">
      <div class="score-head"><span class="score-label">${label}</span><span class="score-value num">${v.toFixed(1)}<span class="unit">/10</span></span></div>
      <div class="score-bar"><div class="score-fill" style="width:${(v / 10) * 100}%"></div></div>
    </div>`;
  const stationTxt = f.stationsIn > 0
    ? `${f.stationsIn} in the area${f.nearestStation && f.nearestStation.name ? ` · ${esc(f.nearestStation.name)}` : ""}`
    : f.nearestStation
      ? `nearest ${esc(f.nearestStation.name || "station")} · ${f.nearestStation.distKm} km`
      : "none nearby";
  const mallTxt = f.nearestMall
    ? f.nearestMall.distKm === 0
      ? `${esc(f.nearestMall.name || "centre")} in the area`
      : `nearest ${esc(f.nearestMall.name || "centre")} · ${f.nearestMall.distKm} km`
    : "none nearby";
  return `<span class="eyebrow">Location &amp; amenities</span>
    <div class="scores">${score("Transit", sc.transit)}${score("Schools", sc.schools)}${score("Shops", sc.shopping)}</div>
    <div class="table-wrap"><table class="data-table"><tbody>
      <tr><td>Public transport</td><td class="right">${stationTxt}</td></tr>
      <tr><td>Schools</td><td class="right num">${f.schoolsIn} in the area</td></tr>
      <tr><td>Shopping centre</td><td class="right">${mallTxt}</td></tr>
      <tr><td>Supermarkets</td><td class="right num">${f.supermarketsIn} in the area</td></tr>
    </tbody></table></div>`;
}

function salesSectionHtml(s) {
  if (s.sales && s.sales.length) {
    const rows = s.sales
      .map((sale) => `<tr><td class="num">${sale.date.slice(2)}</td><td>${esc(sale.address)}<span class="sub">${esc(sale.type)}</span></td><td class="right num strong">${fmtMoney(sale.price)}</td></tr>`)
      .join("");
    return `<span class="eyebrow">Recent sales · ${s.sales.length} most recent</span>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Property</th><th class="right">Price</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }
  if (s.salesSummary) {
    const sum = s.salesSummary;
    const row = (label, d) =>
      d && (d.count != null || d.median != null)
        ? `<tr><td>${label}</td><td class="right num">${d.count ?? "—"}</td><td class="right num strong">${fmtMoney(d.median)}</td></tr>`
        : "";
    const prior = (sum.priorYears || [])
      .map((y) => `<tr><td class="num">${y.year}</td><td class="right num">${y.houseCount ?? "—"}</td><td class="right num">${fmtMoney(y.houseMedian)}</td><td class="right num">${y.unitCount ?? "—"}</td><td class="right num">${fmtMoney(y.unitMedian)}</td></tr>`)
      .join("");
    return `<span class="eyebrow">Sales · ${esc(sum.period)}</span>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Dwellings</th><th class="right">Sales</th><th class="right">Median</th></tr></thead>
        <tbody>${row("Houses", sum.detached)}${row("Units", sum.attached)}${row("All", sum.total)}</tbody></table></div>
      <span class="eyebrow">Prior years · ABS, year to 30 June</span>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Year</th><th class="right">Houses</th><th class="right">Median</th><th class="right">Units</th><th class="right">Median</th></tr></thead>
        <tbody>${prior}</tbody></table></div>`;
  }
  return '<p class="hint hint-quiet">No sales detail available for this area.</p>';
}

function showDetail(name) {
  const entry = suburbIndex.get(name);
  if (!entry || !entry.stats) return;
  const { stats: s, am, rent } = entry;
  const rate = fmtRate(s.monthlyChangePct);
  const rating = combinedScore(s, am, rent);
  const longChange = s.change12mPct ?? s.change18mPct;
  const longLabel = s.change12mPct != null ? "12 months" : "Since FY24";
  const longCls = longChange == null ? "is-flat" : longChange <= -0.5 ? "is-down" : longChange >= 0.5 ? "is-up" : "is-flat";

  panelContent.innerHTML = `
    <button class="back-btn" id="detail-back" type="button">← ${MODE_HEADINGS[currentMode]}</button>
    <div class="detail-head">
      <div>
        <h2 class="detail-name">${esc(name)}</h2>
        <p class="detail-sub">${CITIES[currentCity].label}${s.trendClass ? ` · ${esc(s.trendClass)} market` : ""}</p>
      </div>
      ${rating != null
        ? `<div class="rating-chip" style="--chip-accent:${bucketColor(RATING_BUCKETS, rating)}">
             <span class="rating-chip-value num">${rating}</span>
             <span class="rating-chip-label">Rating</span>
           </div>`
        : ""}
    </div>

    <span class="eyebrow">Price</span>
    <div class="metrics">
      <div class="metric"><div class="metric-label">Median</div><div class="metric-value num">${fmtMoney(s.medianValue)}</div></div>
      <div class="metric"><div class="metric-label">Per month</div><div class="metric-value num ${rate.cls}">${rate.text}</div></div>
      <div class="metric"><div class="metric-label">${longLabel}</div><div class="metric-value num ${longCls}">${longChange == null ? "—" : (longChange > 0 ? "+" : "") + longChange + "%"}</div></div>
    </div>
    <p class="hint hint-quiet">As at ${esc(s.medianAsOf || "latest period")}${s.salesInWindow ? ` · ${s.salesInWindow} sales in the window` : ""}.</p>

    ${rentSectionHtml(rent)}
    ${amenitySectionHtml(am)}

    <span class="eyebrow">Median history${s.trendClass ? ` · ${esc(s.trendClass)}` : ""}</span>
    <div class="spark-card">
      ${sparklineSvg(s.history)}
      ${s.history && s.history.length >= 2
        ? `<div class="spark-foot"><span class="num">${s.history[0].month} · ${fmtMoney(s.history[0].median)}</span><span class="num">${s.history[s.history.length - 1].month} · ${fmtMoney(s.history[s.history.length - 1].median)}</span></div>`
        : ""}
    </div>

    ${salesSectionHtml(s)}
    ${provenanceHtml()}`;

  document.getElementById("detail-back").addEventListener("click", restoreDefaultPanel);
  document.getElementById("panel").scrollTop = 0;
}

/* --- search -------------------------------------------------------------- */

function buildSearch() {
  const datalist = document.getElementById("suburb-list");
  const names = [...suburbIndex.keys()].sort();
  datalist.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
  const input = document.getElementById("search");
  input.onchange = () => {
    const match = names.find((n) => n.toLowerCase() === input.value.trim().toLowerCase());
    if (match) { flyToSuburb(match); input.blur(); }
  };
}

/* --- boot ---------------------------------------------------------------- */

document.getElementById("city-sydney").addEventListener("click", () => loadCity("sydney"));
document.getElementById("city-brisbane").addEventListener("click", () => loadCity("brisbane"));
for (const m of ["trend", "yield", "amenities", "combined"]) {
  document.getElementById(`mode-${m}`).addEventListener("click", () => setMode(m));
}
document.getElementById("theme-toggle").addEventListener("click", () => {
  themePref = THEME_ORDER[(THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length];
  localStorage.setItem("theme", themePref);
  applyTheme();
});

applyTheme();
loadCity("sydney");
