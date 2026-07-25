/* Suburb Opportunity Map — real data edition.
 * Green = median values falling (opportunity), red = flat/still rising.
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

// --- diverging colour scale (green arm = falling, red arm = rising) -------
// Monotone-lightness arms with a neutral grey midpoint; the % labels on the
// map are the secondary (colour-independent) encoding.
const BUCKETS = [
  { max: -1.5, color: "#2e7d32", label: "Falling ≥ 1.5%/mo — strongest opportunity" },
  { max: -0.75, color: "#5aab5e", label: "Falling 0.75–1.5%/mo" },
  { max: -0.25, color: "#b7dfb9", label: "Easing 0.25–0.75%/mo" },
  { max: 0.25, color: "#cfcdc6", label: "Flat (±0.25%/mo)" },
  { max: 0.75, color: "#f2b8aa", label: "Rising 0.25–0.75%/mo" },
  { max: 1.5, color: "#e06a4a", label: "Rising 0.75–1.5%/mo" },
  { max: Infinity, color: "#b02e23", label: "Rising ≥ 1.5%/mo — holding expensive" },
];
const NO_DATA_COLOR = "#b8b6b0";

function bucketColor(pct) {
  for (const b of BUCKETS) if (pct < b.max || b.max === Infinity) return b.color;
  return BUCKETS[BUCKETS.length - 1].color;
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
let market = {};
let marketMeta = {};
let geoLayer = null;
let labelLayer = L.layerGroup();
const suburbIndex = new Map(); // name -> { layer, centroid, stats }
let defaultPanelHtml = "";
const panelContent = document.getElementById("panel-content");

function baseStyle(feature) {
  const stats = market[feature.properties.name];
  const hasTrend = stats && stats.monthlyChangePct != null;
  return {
    fillColor: hasTrend ? bucketColor(stats.monthlyChangePct) : NO_DATA_COLOR,
    fillOpacity: hasTrend ? 0.55 : 0.18,
    color: darkQuery.matches ? "rgba(255,255,255,0.35)" : "rgba(11,11,11,0.30)",
    weight: 1,
    dashArray: hasTrend ? null : "3 3",
  };
}

async function loadCity(city) {
  currentCity = city;
  const cfg = CITIES[city];
  document.querySelectorAll(".city-btn").forEach((b) => {
    const active = b.id === `city-${city}`;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  document.getElementById("subtitle").textContent = `Loading ${cfg.label}…`;

  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
  labelLayer.clearLayers();
  suburbIndex.clear();

  const [geo, mkt] = await Promise.all([
    fetch(`${cfg.dir}/suburbs.geojson`).then((r) => r.json()),
    fetch(`${cfg.dir}/market.json`).then((r) => r.json()),
  ]);
  market = mkt.suburbs;
  marketMeta = mkt;

  document.getElementById("subtitle").innerHTML =
    `${cfg.label} · real ${mkt.trendLabel || "price trend"} · updated ${mkt.generatedAt}`;
  const attrib = document.getElementById("attrib-source");
  if (attrib) attrib.textContent = mkt.source;

  buildChoropleth(geo, cfg);
  buildLabels(geo);
  buildOpportunityList(cfg);
  buildSearch();
  map.setView(cfg.center, cfg.zoom);
  syncLabelVisibility();
}

function buildChoropleth(geo, cfg) {
  geoLayer = L.geoJSON(geo, {
    style: baseStyle,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.name;
      const stats = market[name];
      suburbIndex.set(name, { layer, centroid: feature.properties.centroid, stats });
      const rate = stats ? fmtRate(stats.monthlyChangePct) : { text: "no data" };
      layer.bindTooltip(
        `<strong>${name}</strong><br>${stats && stats.medianValue ? fmtMoney(stats.medianValue) + " median · " + rate.text : "insufficient sales data"}`,
        { sticky: true, className: "suburb-tip" }
      );
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
  buildLegend();
}

// --- rate labels on suburbs ----------------------------------------------
function buildLabels(geo) {
  for (const f of geo.features) {
    const name = f.properties.name;
    const stats = market[name];
    if (!stats || stats.monthlyChangePct == null) continue;
    const rate = fmtRate(stats.monthlyChangePct);
    const icon = L.divIcon({
      className: "rate-pill",
      html: `<span><span class="pill-name">${name} </span><span class="${rate.cls}">${rate.text}</span></span>`,
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

// Suburb names inside pills only appear when zoomed right in.
const nameCss = document.createElement("style");
nameCss.textContent = "#map:not(.show-names) .pill-name{display:none}";
document.head.appendChild(nameCss);

// --- legend ---------------------------------------------------------------
let legendControl = null;
function buildLegend() {
  if (legendControl) map.removeControl(legendControl);
  legendControl = L.control({ position: "bottomleft" });
  legendControl.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML =
      `<h3>Median price trend (${marketMeta.trendLabel || ""})</h3>` +
      BUCKETS.map(
        (b) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`
      ).join("") +
      `<div class="legend-row"><span class="legend-swatch" style="background:${NO_DATA_COLOR};opacity:.4;border-style:dashed"></span>Insufficient sales data</div>` +
      '<div class="legend-note">Green areas are cooling — potential buying opportunities. Red areas are flat or still climbing.</div>';
    return div;
  };
  legendControl.addTo(map);
}

// --- side panel -----------------------------------------------------------
function buildOpportunityList(cfg) {
  const top = [...suburbIndex.entries()]
    .filter(([, v]) => v.stats && v.stats.monthlyChangePct != null)
    .sort((a, b) => a[1].stats.monthlyChangePct - b[1].stats.monthlyChangePct)
    .slice(0, 15);
  panelContent.innerHTML = `
    <h2 class="panel-heading">Top opportunities — ${cfg.label}</h2>
    <p class="panel-hint">${cfg.areaWord[0].toUpperCase() + cfg.areaWord.slice(1)}s with the fastest-falling median values (${marketMeta.trendLabel}). Click one — or any area on the map — for detail.</p>
    <ol class="opportunity-list" id="opportunity-list"></ol>
    <p class="panel-hint" style="margin-top:12px">${marketMeta.source}</p>`;
  const list = document.getElementById("opportunity-list");
  for (const [name, v] of top) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const rate = fmtRate(v.stats.monthlyChangePct);
    const n = v.stats.salesInWindow;
    btn.innerHTML = `<span>${name}${n ? ` <span style="color:var(--muted);font-size:11px">· ${n} sales</span>` : ""}</span><span class="${rateSpanCls(rate.cls)}">${rate.text}</span>`;
    btn.addEventListener("click", () => flyToSuburb(name));
    li.appendChild(btn);
    list.appendChild(li);
  }
  defaultPanelHtml = panelContent.innerHTML;
}

function restoreDefaultPanel() {
  panelContent.innerHTML = defaultPanelHtml;
  panelContent.querySelectorAll(".opportunity-list button").forEach((btn) => {
    const name = btn.querySelector("span").textContent;
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
  const rate = fmtRate(s.monthlyChangePct);
  const longChange = s.change12mPct ?? s.change18mPct;
  const longLabel = s.change12mPct != null ? "12 months" : "Since FY2024";
  panelContent.innerHTML = `
    <button class="detail-back" id="detail-back">← Top opportunities</button>
    <h2 class="detail-name">${name}</h2>
    <div class="stat-row">
      <div class="stat-tile"><div class="stat-label">Median (${s.medianAsOf || "latest"})</div><div class="stat-value">${fmtMoney(s.medianValue)}</div></div>
      <div class="stat-tile"><div class="stat-label">${marketMeta.trendLabel || "Trend"}${s.trendClass ? ` (${s.trendClass})` : ""}</div><div class="stat-value ${rateSpanCls(rate.cls)}">${rate.text}</div></div>
      <div class="stat-tile"><div class="stat-label">${longLabel}</div><div class="stat-value ${longChange == null ? "rate-flat" : longChange <= -0.5 ? "rate-down" : longChange >= 0.5 ? "rate-up" : "rate-flat"}">${longChange == null ? "—" : (longChange > 0 ? "+" : "") + longChange + "%"}</div></div>
    </div>
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
  input.value = "";
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
loadCity("sydney");
