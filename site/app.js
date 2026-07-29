/* Suburb Opportunity Map — real data edition.
 * Views: price trend (green = falling / opportunity, red = flat/rising),
 * amenity access (transit, schools, shopping from OpenStreetMap), and a
 * combined opportunity rating blending the two.
 * Sydney: NSW Valuer General bulk property sales (individual sales records).
 * Brisbane: QGSO Housing Profiles (QVAS) + ABS Data by region annual medians.
 */

"use strict";

const CITIES = {
  sydney: {
    label: "Sydney",
    dir: "data/sydney",
    center: [-33.85, 151.08],
    zoom: 11,
    areaWord: "suburb",
  },
  brisbane: {
    label: "Brisbane",
    dir: "data/brisbane",
    center: [-27.47, 153.02],
    zoom: 10,
    areaWord: "SA2 area",
  },
};

// --- colour scales --------------------------------------------------------
// Trend: diverging, green arm = falling, red arm = rising, grey midpoint.
// Amenities: sequential blue (magnitude). Rating: sequential green.
// The value labels on the map are the colour-independent secondary encoding.
const TREND_BUCKETS = [
  { max: -1.5, color: "#2e7d32", label: "Falling ≥ 1.5%/mo — strongest opportunity" },
  { max: -0.75, color: "#5aab5e", label: "Falling 0.75–1.5%/mo" },
  { max: -0.25, color: "#b7dfb9", label: "Easing 0.25–0.75%/mo" },
  { max: 0.25, color: "#cfcdc6", label: "Flat (±0.25%/mo)" },
  { max: 0.75, color: "#f2b8aa", label: "Rising 0.25–0.75%/mo" },
  { max: 1.5, color: "#e06a4a", label: "Rising 0.75–1.5%/mo" },
  { max: Infinity, color: "#b02e23", label: "Rising ≥ 1.5%/mo — holding expensive" },
];
const AMENITY_BUCKETS = [
  { max: 2, color: "#cde2fb", label: "0–2 — few amenities" },
  { max: 4, color: "#9ec5f4", label: "2–4" },
  { max: 6, color: "#5598e7", label: "4–6" },
  { max: 8, color: "#2a78d6", label: "6–8" },
  { max: Infinity, color: "#1c5cab", label: "8–10 — best served" },
];
const RATING_BUCKETS = [
  { max: 20, color: "#e7f0e7", label: "0–20 — weak" },
  { max: 40, color: "#c4e0c6", label: "20–40" },
  { max: 55, color: "#8cc790", label: "40–55" },
  { max: 70, color: "#5aab5e", label: "55–70" },
  { max: 85, color: "#3c8f42", label: "70–85" },
  { max: Infinity, color: "#1e6323", label: "85–100 — strongest opportunity" },
];
const NO_DATA_COLOR = "#b8b6b0";

function bucketColor(buckets, v) {
  for (const b of buckets) if (v < b.max || b.max === Infinity) return b.color;
  return buckets[buckets.length - 1].color;
}

const fmtMoney = (v) =>
  v == null ? "—" : v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;
const fmtRate = (pct) => {
  if (pct == null) return { cls: "flat", text: "no data" };
  if (pct <= -0.25) return { cls: "down", text: `▼ ${Math.abs(pct).toFixed(1)}%/mo` };
  if (pct >= 0.25) return { cls: "up", text: `▲ ${pct.toFixed(1)}%/mo` };
  return { cls: "flat", text: "◆ flat" };
};
const rateSpanCls = (cls) => (cls === "down" ? "rate-down" : cls === "up" ? "rate-up" : "rate-flat");

// Combined 0-100 rating: 60% price momentum (falling = good), 40% amenities.
// -2.0%/mo or better -> full trend marks; +0.5%/mo or worse -> zero.
function combinedScore(stats, am) {
  if (!stats || stats.monthlyChangePct == null || !am) return null;
  const trendScore = Math.max(0, Math.min(1, (-stats.monthlyChangePct + 0.5) / 2.5));
  return Math.round(100 * (0.6 * trendScore + 0.4 * (am.scores.total / 10)));
}

// --- map ------------------------------------------------------------------
const map = L.map("map", { zoomControl: true }).setView(CITIES.sydney.center, CITIES.sydney.zoom);
window.__map = map; // console/debug handle

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let tileLayer = null;
function setTiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  const style = darkQuery.matches ? "dark_all" : "light_all";
  tileLayer = L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`,
    {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · <span id="attrib-source"></span>',
    }
  ).addTo(map);
  tileLayer.bringToBack();
}
setTiles();
darkQuery.addEventListener("change", setTiles);

// --- state ----------------------------------------------------------------
let currentCity = "sydney";
let currentMode = "trend"; // trend | amenities | combined
let market = {};
let marketMeta = {};
let amenities = {};
let amenityMeta = {};
let currentGeo = null;
let geoLayer = null;
let labelLayer = L.layerGroup();
const suburbIndex = new Map(); // name -> { layer, centroid, stats, am }
let defaultPanelHtml = "";
const panelContent = document.getElementById("panel-content");

// mode value for a suburb: { v, text } or null
function modeValue(name) {
  const entry = suburbIndex.get(name) || { stats: market[name], am: amenities[name] };
  const { stats, am } = entry;
  if (currentMode === "trend") {
    if (!stats || stats.monthlyChangePct == null) return null;
    const r = fmtRate(stats.monthlyChangePct);
    return { v: stats.monthlyChangePct, text: r.text, cls: r.cls, buckets: TREND_BUCKETS, asc: true };
  }
  if (currentMode === "amenities") {
    if (!am) return null;
    return { v: am.scores.total, text: `◇ ${am.scores.total.toFixed(1)}`, cls: "flat", buckets: AMENITY_BUCKETS, asc: false };
  }
  const score = combinedScore(stats, am);
  if (score == null) return null;
  return { v: score, text: `★ ${score}`, cls: "flat", buckets: RATING_BUCKETS, asc: false };
}

function styleFor(feature) {
  const mv = modeValue(feature.properties.name);
  return {
    fillColor: mv ? bucketColor(mv.buckets, mv.v) : NO_DATA_COLOR,
    fillOpacity: mv ? 0.55 : 0.18,
    color: darkQuery.matches ? "rgba(255,255,255,0.35)" : "rgba(11,11,11,0.30)",
    weight: 1,
    dashArray: mv ? null : "3 3",
  };
}

const MODE_TITLES = {
  trend: () => `Median price trend (${marketMeta.trendLabel || ""})`,
  amenities: () => "Amenity access score (0–10)",
  combined: () => "Opportunity rating (0–100)",
};
const MODE_LIST_HEADINGS = {
  trend: "Top opportunities — fastest-falling medians",
  amenities: "Best-served areas — amenity score",
  combined: "Top opportunity ratings — price momentum + amenities",
};

async function loadCity(city) {
  currentCity = city;
  const cfg = CITIES[city];
  document.querySelectorAll("[id^=city-]").forEach((b) => {
    const active = b.id === `city-${city}`;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  document.getElementById("subtitle").textContent = `Loading ${cfg.label}…`;

  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  labelLayer.clearLayers();
  suburbIndex.clear();

  const [geo, mkt, amen] = await Promise.all([
    fetch(`${cfg.dir}/suburbs.geojson`).then((r) => r.json()),
    fetch(`${cfg.dir}/market.json`).then((r) => r.json()),
    fetch(`${cfg.dir}/amenities.json`).then((r) => (r.ok ? r.json() : { suburbs: {} })).catch(() => ({ suburbs: {} })),
  ]);
  market = mkt.suburbs;
  marketMeta = mkt;
  amenities = amen.suburbs || {};
  amenityMeta = amen;
  currentGeo = geo;

  document.getElementById("subtitle").innerHTML =
    `${cfg.label} · real ${mkt.trendLabel || "price trend"} · updated ${mkt.generatedAt}`;
  const attrib = document.getElementById("attrib-source");
  if (attrib) attrib.textContent = mkt.source;

  geoLayer = L.geoJSON(geo, {
    style: styleFor,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.name;
      suburbIndex.set(name, { layer, centroid: feature.properties.centroid, stats: market[name], am: amenities[name] });
      layer.on({
        mouseover: (e) => {
          e.target.setStyle({ weight: 2.5, fillOpacity: 0.72 });
          e.target.bringToFront();
        },
        mouseout: (e) => geoLayer.resetStyle(e.target),
        click: () => showDetail(name),
      });
    },
  }).addTo(map);

  refreshMode();
  map.setView(cfg.center, cfg.zoom);
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("[id^=mode-]").forEach((b) => {
    const active = b.id === `mode-${mode}`;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  refreshMode();
}

function refreshMode() {
  if (!geoLayer) return;
  geoLayer.setStyle(styleFor);
  // tooltips
  suburbIndex.forEach((entry, name) => {
    const mv = modeValue(name);
    const median = entry.stats && entry.stats.medianValue ? `${fmtMoney(entry.stats.medianValue)} median · ` : "";
    entry.layer.unbindTooltip();
    entry.layer.bindTooltip(
      `<strong>${name}</strong><br>${median}${mv ? mv.text : "insufficient data"}`,
      { sticky: true, className: "suburb-tip" }
    );
  });
  buildLabels();
  buildLegend();
  buildRankList();
  buildSearch();
  syncLabelVisibility();
}

// --- value labels on suburbs ---------------------------------------------
function buildLabels() {
  labelLayer.clearLayers();
  if (!currentGeo) return;
  for (const f of currentGeo.features) {
    const name = f.properties.name;
    const mv = modeValue(name);
    if (!mv) continue;
    const icon = L.divIcon({
      className: "rate-pill",
      html: `<span><span class="pill-name">${name} </span><span class="${mv.cls}">${mv.text}</span></span>`,
      iconSize: [0, 0],
    });
    const [lng, lat] = f.properties.centroid;
    labelLayer.addLayer(L.marker([lat, lng], { icon, interactive: false, keyboard: false }));
  }
}

function syncLabelVisibility() {
  const z = map.getZoom();
  const wantLabels = z >= 12;
  const onMap = map.hasLayer(labelLayer);
  if (wantLabels && !onMap) labelLayer.addTo(map);
  if (!wantLabels && onMap) map.removeLayer(labelLayer);
  document.getElementById("map").classList.toggle("show-names", z >= 14);
}
map.on("zoomend", syncLabelVisibility);

const nameCss = document.createElement("style");
nameCss.textContent = "#map:not(.show-names) .pill-name{display:none}";
document.head.appendChild(nameCss);

// --- legend ---------------------------------------------------------------
let legendControl = null;
function buildLegend() {
  if (legendControl) map.removeControl(legendControl);
  const buckets = currentMode === "trend" ? TREND_BUCKETS : currentMode === "amenities" ? AMENITY_BUCKETS : RATING_BUCKETS;
  legendControl = L.control({ position: "bottomleft" });
  legendControl.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML =
      `<h3>${MODE_TITLES[currentMode]()}</h3>` +
      buckets.map(
        (b) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`
      ).join("") +
      `<div class="legend-row"><span class="legend-swatch" style="background:${NO_DATA_COLOR};opacity:.4;border-style:dashed"></span>Insufficient data</div>` +
      (currentMode === "trend"
        ? '<div class="legend-note">Green areas are cooling — potential buying opportunities. Red areas are flat or still climbing.</div>'
        : currentMode === "amenities"
          ? '<div class="legend-note">Transit, schools and shopping access scored from OpenStreetMap locations.</div>'
          : '<div class="legend-note">60% price momentum (falling = better) + 40% amenity access.</div>');
    return div;
  };
  legendControl.addTo(map);
}

// --- side panel -----------------------------------------------------------
function buildRankList() {
  const cfg = CITIES[currentCity];
  const ranked = [...suburbIndex.keys()]
    .map((name) => ({ name, mv: modeValue(name), stats: suburbIndex.get(name).stats }))
    .filter((x) => x.mv)
    .sort((a, b) => (a.mv.asc ? a.mv.v - b.mv.v : b.mv.v - a.mv.v))
    .slice(0, 15);
  panelContent.innerHTML = `
    <h2 class="panel-heading">${MODE_LIST_HEADINGS[currentMode]}</h2>
    <p class="panel-hint">${cfg.label} · click an entry — or any area on the map — for detail.</p>
    <ol class="opportunity-list" id="opportunity-list"></ol>
    <p class="panel-hint" style="margin-top:12px">${marketMeta.source}${amenityMeta.source ? " · Amenities: " + amenityMeta.source : ""}</p>`;
  const list = document.getElementById("opportunity-list");
  for (const { name, mv, stats } of ranked) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const n = currentMode === "trend" && stats ? stats.salesInWindow : null;
    btn.innerHTML = `<span>${name}${n ? ` <span style="color:var(--muted);font-size:11px">· ${n} sales</span>` : ""}</span><span class="${rateSpanCls(mv.cls)}">${mv.text}</span>`;
    btn.addEventListener("click", () => flyToSuburb(name));
    li.appendChild(btn);
    list.appendChild(li);
  }
  defaultPanelHtml = panelContent.innerHTML;
}

function restoreDefaultPanel() {
  panelContent.innerHTML = defaultPanelHtml;
  panelContent.querySelectorAll(".opportunity-list button").forEach((btn) => {
    const name = btn.querySelector("span").textContent.split("·")[0].trim();
    btn.addEventListener("click", () => flyToSuburb(name));
  });
}

function flyToSuburb(name) {
  const entry = suburbIndex.get(name);
  if (!entry) return;
  const [lng, lat] = entry.centroid;
  map.flyTo([lat, lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
  showDetail(name);
}

function sparklineSvg(history) {
  if (!history || history.length < 2) return '<p class="panel-hint">Not enough history.</p>';
  const w = 300, h = 72, pad = 4;
  const values = history.map((p) => p.median);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return [x, y];
  });
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Median price history">
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${ex}" cy="${ey}" r="3.5" fill="var(--accent)"/>
  </svg>`;
}

function amenitySectionHtml(am) {
  if (!am) return "";
  const sc = am.scores, f = am.facts;
  const chip = (label, v) =>
    `<div class="stat-tile"><div class="stat-label">${label}</div><div class="stat-value">${v.toFixed(1)}<span style="font-size:12px;color:var(--muted)">/10</span></div></div>`;
  const stationTxt = f.stationsIn > 0
    ? `${f.stationsIn} station${f.stationsIn > 1 ? "s" : ""} in area${f.nearestStation && f.nearestStation.name ? ` (${f.nearestStation.name})` : ""}`
    : f.nearestStation
      ? `nearest: ${f.nearestStation.name || "station"} · ${f.nearestStation.distKm} km`
      : "none nearby";
  const mallTxt = f.nearestMall
    ? f.nearestMall.distKm === 0
      ? `${f.nearestMall.name || "shopping centre"} in area`
      : `nearest: ${f.nearestMall.name || "shopping centre"} · ${f.nearestMall.distKm} km`
    : "none nearby";
  return `
    <div class="section-label">Location &amp; amenities</div>
    <div class="stat-row">${chip("Transit", sc.transit)}${chip("Schools", sc.schools)}${chip("Shopping", sc.shopping)}</div>
    <table class="sales-table">
      <tbody>
        <tr><td>Public transport</td><td>${stationTxt}</td></tr>
        <tr><td>Schools</td><td>${f.schoolsIn} in area</td></tr>
        <tr><td>Shopping centre</td><td>${mallTxt}</td></tr>
        <tr><td>Supermarkets</td><td>${f.supermarketsIn} in area</td></tr>
      </tbody>
    </table>`;
}

function salesSectionHtml(s) {
  if (s.sales && s.sales.length) {
    const rows = s.sales
      .map(
        (sale) =>
          `<tr><td>${sale.date.slice(2)}</td><td>${sale.address}<br><span style="color:var(--muted)">${sale.type}</span></td><td class="price">${fmtMoney(sale.price)}</td></tr>`
      )
      .join("");
    return `<div class="section-label">Recent sales (${s.sales.length} most recent)</div>
      <table class="sales-table">
        <thead><tr><th>Date</th><th>Property</th><th class="price">Price</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
  if (s.salesSummary) {
    const sum = s.salesSummary;
    const row = (label, d) =>
      d && (d.count != null || d.median != null)
        ? `<tr><td>${label}</td><td class="price">${d.count ?? "—"}</td><td class="price">${fmtMoney(d.median)}</td></tr>`
        : "";
    const prior = (sum.priorYears || [])
      .map(
        (y) =>
          `<tr><td>${y.year}</td><td class="price">${y.houseCount ?? "—"}</td><td class="price">${fmtMoney(y.houseMedian)}</td><td class="price">${y.unitCount ?? "—"}</td><td class="price">${fmtMoney(y.unitMedian)}</td></tr>`
      )
      .join("");
    return `<div class="section-label">Sales — ${sum.period}</div>
      <table class="sales-table">
        <thead><tr><th>Dwellings</th><th class="price">Sales</th><th class="price">Median</th></tr></thead>
        <tbody>${row("Houses", sum.detached)}${row("Units", sum.attached)}${row("All", sum.total)}</tbody>
      </table>
      <div class="section-label">Prior years (ABS, year ended 30 June)</div>
      <table class="sales-table">
        <thead><tr><th>Year</th><th class="price">House sales</th><th class="price">Median</th><th class="price">Unit sales</th><th class="price">Median</th></tr></thead>
        <tbody>${prior}</tbody>
      </table>`;
  }
  return '<p class="panel-hint">No sales data available for this area.</p>';
}

function showDetail(name) {
  const entry = suburbIndex.get(name);
  if (!entry || !entry.stats) return;
  const s = entry.stats;
  const am = entry.am;
  const rate = fmtRate(s.monthlyChangePct);
  const rating = combinedScore(s, am);
  const longChange = s.change12mPct ?? s.change18mPct;
  const longLabel = s.change12mPct != null ? "12 months" : "Since FY2024";
  panelContent.innerHTML = `
    <button class="detail-back" id="detail-back">← Back to list</button>
    <h2 class="detail-name">${name}${rating != null ? ` <span style="font-size:13px;color:var(--muted)">★ ${rating}/100</span>` : ""}</h2>
    <div class="stat-row">
      <div class="stat-tile"><div class="stat-label">Median (${s.medianAsOf || "latest"})</div><div class="stat-value">${fmtMoney(s.medianValue)}</div></div>
      <div class="stat-tile"><div class="stat-label">${marketMeta.trendLabel || "Trend"}${s.trendClass ? ` (${s.trendClass})` : ""}</div><div class="stat-value ${rateSpanCls(rate.cls)}">${rate.text}</div></div>
      <div class="stat-tile"><div class="stat-label">${longLabel}</div><div class="stat-value ${longChange == null ? "rate-flat" : longChange <= -0.5 ? "rate-down" : longChange >= 0.5 ? "rate-up" : "rate-flat"}">${longChange == null ? "—" : (longChange > 0 ? "+" : "") + longChange + "%"}</div></div>
    </div>
    ${amenitySectionHtml(am)}
    <div class="section-label">Median history${s.trendClass ? ` — ${s.trendClass}` : ""}</div>
    <div class="sparkline-wrap">${sparklineSvg(s.history)}
      ${s.history && s.history.length >= 2 ? `<div class="spark-caption"><span>${s.history[0].month} · ${fmtMoney(s.history[0].median)}</span><span>${s.history[s.history.length - 1].month} · ${fmtMoney(s.history[s.history.length - 1].median)}</span></div>` : ""}
    </div>
    ${salesSectionHtml(s)}`;
  document.getElementById("detail-back").addEventListener("click", restoreDefaultPanel);
  document.getElementById("panel").scrollTop = 0;
}

// --- search ---------------------------------------------------------------
function buildSearch() {
  const datalist = document.getElementById("suburb-list");
  const names = [...suburbIndex.keys()].sort();
  datalist.innerHTML = names.map((n) => `<option value="${n}"></option>`).join("");
  const input = document.getElementById("search");
  input.onchange = () => {
    const match = names.find((n) => n.toLowerCase() === input.value.trim().toLowerCase());
    if (match) {
      flyToSuburb(match);
      input.blur();
    }
  };
}

// --- boot -----------------------------------------------------------------
document.getElementById("city-sydney").addEventListener("click", () => loadCity("sydney"));
document.getElementById("city-brisbane").addEventListener("click", () => loadCity("brisbane"));
document.getElementById("mode-trend").addEventListener("click", () => setMode("trend"));
document.getElementById("mode-amenities").addEventListener("click", () => setMode("amenities"));
document.getElementById("mode-combined").addEventListener("click", () => setMode("combined"));
loadCity("sydney");
