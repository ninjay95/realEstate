/* Suburb Opportunity Map
 * Green = median values falling (opportunity), red = flat/still rising.
 * Data comes from data/suburbs.geojson (boundaries) + data/market.json
 * (sales/valuations — currently generated sample data, see scripts/).
 */

"use strict";

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

function bucketColor(pct) {
  for (const b of BUCKETS) if (pct < b.max || b.max === Infinity) return b.color;
  return BUCKETS[BUCKETS.length - 1].color;
}

const fmtMoney = (v) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}K`;
const fmtRate = (pct) => {
  if (pct <= -0.25) return { cls: "down", text: `▼ ${Math.abs(pct).toFixed(1)}%/mo` };
  if (pct >= 0.25) return { cls: "up", text: `▲ ${pct.toFixed(1)}%/mo` };
  return { cls: "flat", text: "◆ flat" };
};

// --- map ------------------------------------------------------------------
const map = L.map("map", { zoomControl: true }).setView([-33.85, 151.08], 11);
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
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · boundaries: PSMA via GeoJson-Data · sample market data',
    }
  ).addTo(map);
  tileLayer.bringToBack();
}
setTiles();
darkQuery.addEventListener("change", setTiles);

// --- load data ------------------------------------------------------------
let market = {};
let geoLayer = null;
const labelLayer = L.layerGroup();
const suburbIndex = new Map(); // name -> { layer, centroid, stats }

Promise.all([
  fetch("data/suburbs.geojson").then((r) => r.json()),
  fetch("data/market.json").then((r) => r.json()),
]).then(([geo, mkt]) => {
  market = mkt.suburbs;
  buildChoropleth(geo);
  buildLabels(geo);
  buildLegend();
  buildOpportunityList();
  buildSearch();
  syncLabelVisibility();
});

function baseStyle(feature) {
  const stats = market[feature.properties.name];
  return {
    fillColor: stats ? bucketColor(stats.monthlyChangePct) : "#cfcdc6",
    fillOpacity: 0.55,
    color: darkQuery.matches ? "rgba(255,255,255,0.35)" : "rgba(11,11,11,0.30)",
    weight: 1,
  };
}

function buildChoropleth(geo) {
  geoLayer = L.geoJSON(geo, {
    style: baseStyle,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.name;
      const stats = market[name];
      suburbIndex.set(name, { layer, centroid: feature.properties.centroid, stats });
      const rate = stats ? fmtRate(stats.monthlyChangePct) : { text: "no data" };
      layer.bindTooltip(
        `<strong>${name}</strong><br>${stats ? fmtMoney(stats.medianValue) + " median · " + rate.text : "no data"}`,
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
}

// --- rate labels on suburbs ----------------------------------------------
function buildLabels(geo) {
  for (const f of geo.features) {
    const name = f.properties.name;
    const stats = market[name];
    if (!stats) continue;
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
function buildLegend() {
  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML =
      "<h3>Median price trend (6 mo)</h3>" +
      BUCKETS.map(
        (b) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`
      ).join("") +
      '<div class="legend-note">Green suburbs are cooling — potential buying opportunities. Red suburbs are flat or still climbing.</div>';
    return div;
  };
  legend.addTo(map);
}

// --- side panel -----------------------------------------------------------
const panelContent = document.getElementById("panel-content");

function buildOpportunityList() {
  const list = document.getElementById("opportunity-list");
  const top = [...suburbIndex.entries()]
    .filter(([, v]) => v.stats)
    .sort((a, b) => a[1].stats.monthlyChangePct - b[1].stats.monthlyChangePct)
    .slice(0, 15);
  list.innerHTML = "";
  for (const [name, v] of top) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const rate = fmtRate(v.stats.monthlyChangePct);
    btn.innerHTML = `<span>${name}</span><span class="${rate.cls === "down" ? "rate-down" : rate.cls === "up" ? "rate-up" : "rate-flat"}">${rate.text}</span>`;
    btn.addEventListener("click", () => flyToSuburb(name));
    li.appendChild(btn);
    list.appendChild(li);
  }
  defaultPanelHtml = panelContent.innerHTML;
}
let defaultPanelHtml = "";

function flyToSuburb(name) {
  const entry = suburbIndex.get(name);
  if (!entry) return;
  const [lng, lat] = entry.centroid;
  map.flyTo([lat, lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
  showDetail(name);
}

function sparklineSvg(history) {
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

function showDetail(name) {
  const entry = suburbIndex.get(name);
  if (!entry || !entry.stats) return;
  const s = entry.stats;
  const rate = fmtRate(s.monthlyChangePct);
  const rateCls = rate.cls === "down" ? "rate-down" : rate.cls === "up" ? "rate-up" : "rate-flat";
  const first = s.history[0], last = s.history[s.history.length - 1];
  const rows = s.sales
    .map(
      (sale) =>
        `<tr><td>${sale.date.slice(5)}</td><td>${sale.address}<br><span style="color:var(--muted)">${sale.type} · ${sale.beds} bed ${sale.baths} bath</span></td><td class="price">${fmtMoney(sale.price)}</td></tr>`
    )
    .join("");
  panelContent.innerHTML = `
    <button class="detail-back" id="detail-back">← Top opportunities</button>
    <h2 class="detail-name">${name}</h2>
    <div class="stat-row">
      <div class="stat-tile"><div class="stat-label">Median value</div><div class="stat-value">${fmtMoney(s.medianValue)}</div></div>
      <div class="stat-tile"><div class="stat-label">Monthly trend</div><div class="stat-value ${rateCls}">${rate.text}</div></div>
      <div class="stat-tile"><div class="stat-label">12 months</div><div class="stat-value ${s.change12mPct <= -0.5 ? "rate-down" : s.change12mPct >= 0.5 ? "rate-up" : "rate-flat"}">${s.change12mPct > 0 ? "+" : ""}${s.change12mPct}%</div></div>
    </div>
    <div class="section-label">Median — last 24 months</div>
    <div class="sparkline-wrap">${sparklineSvg(s.history)}
      <div class="spark-caption"><span>${first.month} · ${fmtMoney(first.median)}</span><span>${last.month} · ${fmtMoney(last.median)}</span></div>
    </div>
    <div class="section-label">Recent sales (${s.sales.length})</div>
    <table class="sales-table">
      <thead><tr><th>Date</th><th>Property</th><th class="price">Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  document.getElementById("detail-back").addEventListener("click", () => {
    panelContent.innerHTML = defaultPanelHtml;
    rebindOpportunityList();
  });
  document.getElementById("panel").scrollTop = 0;
}

function rebindOpportunityList() {
  panelContent.querySelectorAll(".opportunity-list button").forEach((btn) => {
    const name = btn.querySelector("span").textContent;
    btn.addEventListener("click", () => flyToSuburb(name));
  });
}

// --- search ---------------------------------------------------------------
function buildSearch() {
  const datalist = document.getElementById("suburb-list");
  const names = [...suburbIndex.keys()].sort();
  datalist.innerHTML = names.map((n) => `<option value="${n}"></option>`).join("");
  const input = document.getElementById("search");
  input.addEventListener("change", () => {
    const match = names.find((n) => n.toLowerCase() === input.value.trim().toLowerCase());
    if (match) {
      flyToSuburb(match);
      input.blur();
    }
  });
}
