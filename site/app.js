/* Suburb Opportunity Map
 *
 * Houses and units are separate markets, so every measure is computed per
 * dwelling class and the whole map reads against the selected type.
 *
 * Four views:
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
const CLASS_LABEL = { houses: "houses", units: "units" };
const CLASS_TITLE = { houses: "Houses", units: "Units" };
const CLASS_NOUN = { houses: "house", units: "unit" }; // adjectival: "house sales"
const OTHER_CLASS = { houses: "units", units: "houses" };

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

/* --- mortgage calculator -------------------------------------------------
 * Assumptions are the viewer's, not ours: the fields are inputs, prefilled
 * with the selected type's median price and remembered between suburbs. Output
 * is a plain principal-and-interest amortisation, compared against the real
 * median rent for the same area and type so the cash-flow gap is visible.
 */
const LOAN_DEFAULTS = { depositPct: 20, ratePct: 6, termYears: 30 };
let loanInputs = (() => {
  try { return { ...LOAN_DEFAULTS, ...JSON.parse(localStorage.getItem("loanInputs") || "{}") }; }
  catch { return { ...LOAN_DEFAULTS }; }
})();

const audFmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const fmtAud = (v) => (v == null || !Number.isFinite(v) ? "—" : audFmt.format(v));

function monthlyRepayment(principal, annualRatePct, years) {
  const n = Math.round(years * 12);
  if (!(principal > 0) || !(n > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (!(r > 0)) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

function mortgageSectionHtml(stats) {
  const field = (id, label, value, attrs) =>
    `<label class="calc-field" for="${id}">
       <span class="calc-label">${label}</span>
       <input class="calc-input num" id="${id}" type="number" inputmode="decimal" ${attrs} value="${value}" />
     </label>`;
  return `<span class="eyebrow">Repayments</span>
    <div class="calc">
      <div class="calc-grid">
        ${field("calc-price", "Purchase price", stats.medianValue ?? "", 'min="0" step="10000"')}
        ${field("calc-deposit", "Deposit %", loanInputs.depositPct, 'min="0" max="100" step="1"')}
        ${field("calc-rate", "Rate % p.a.", loanInputs.ratePct, 'min="0" max="20" step="0.05"')}
        ${field("calc-term", "Term (years)", loanInputs.termYears, 'min="1" max="40" step="1"')}
      </div>
      <div id="calc-out" aria-live="polite"></div>
      <p class="hint hint-quiet calc-note">Your assumptions, not a quote. Principal and interest only — excludes stamp duty, rates, strata, insurance and any lenders mortgage insurance.</p>
    </div>`;
}

function renderLoanOutputs(rent) {
  const out = document.getElementById("calc-out");
  if (!out) return;
  const val = (id) => Number(document.getElementById(id).value);
  const price = val("calc-price");
  const depositPct = Math.min(100, Math.max(0, val("calc-deposit")));
  const ratePct = val("calc-rate");
  const termYears = val("calc-term");

  if (!(price > 0) || !(termYears > 0)) {
    out.innerHTML = '<p class="hint hint-quiet" style="margin-top:10px">Enter a price and term to see repayments.</p>';
    return;
  }

  const deposit = price * (depositPct / 100);
  const loan = Math.max(0, price - deposit);
  const monthly = monthlyRepayment(loan, ratePct, termYears);
  const weekly = (monthly * 12) / 52;
  const totalInterest = monthly * Math.round(termYears * 12) - loan;

  const rows = [
    ["Loan amount", fmtAud(loan)],
    ["Deposit", fmtAud(deposit)],
    ["Weekly equivalent", fmtAud(weekly)],
    ["Total interest over term", fmtAud(totalInterest)],
  ];

  let rentBlock = "";
  if (rent && rent.medianWeeklyRent) {
    const rentMonthly = (rent.medianWeeklyRent * 52) / 12;
    const coverage = monthly > 0 ? (rentMonthly / monthly) * 100 : 0;
    const gap = monthly - rentMonthly;
    rentBlock = `<tr><td>Median rent covers</td><td class="right num strong">${coverage.toFixed(0)}%</td></tr>
      <tr><td>${gap > 0 ? "Monthly shortfall" : "Monthly surplus"}</td>
          <td class="right num strong ${gap > 0 ? "is-up" : "is-down"}">${fmtAud(Math.abs(gap))}</td></tr>`;
  }

  out.innerHTML = `
    <div class="calc-headline">
      <div class="calc-headline-value num">${fmtAud(monthly)}<span class="unit">/mo</span></div>
      <div class="calc-headline-label">Principal &amp;<br>interest</div>
    </div>
    <div class="table-wrap"><table class="data-table calc-table"><tbody>
      ${rows.map(([k, v]) => `<tr><td>${k}</td><td class="right num">${v}</td></tr>`).join("")}
      ${rentBlock}
    </tbody></table></div>
    ${depositPct < 20 ? '<p class="hint calc-flag">Deposit under 20% — lenders mortgage insurance usually applies and is not included above.</p>' : ""}`;
}

function bindMortgage(rent) {
  for (const id of ["calc-price", "calc-deposit", "calc-rate", "calc-term"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", () => {
      const next = {
        depositPct: Number(document.getElementById("calc-deposit").value),
        ratePct: Number(document.getElementById("calc-rate").value),
        termYears: Number(document.getElementById("calc-term").value),
      };
      if (Object.values(next).every((v) => Number.isFinite(v))) {
        loanInputs = next;
        try { localStorage.setItem("loanInputs", JSON.stringify(loanInputs)); } catch { /* private mode */ }
      }
      renderLoanOutputs(rent);
    });
  }
  renderLoanOutputs(rent);
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
let currentClass = localStorage.getItem("propertyClass") === "units" ? "units" : "houses";
let market = {}, marketMeta = {};
let amenities = {}, amenityMeta = {};
let rents = {}, rentMeta = {};
let currentGeo = null;
let geoLayer = null;
const labelLayer = L.layerGroup();
const suburbIndex = new Map();
let defaultPanelHtml = "";
let openSuburb = null;
const panelContent = document.getElementById("panel-content");

// Per-class accessors — every measure below reads through these.
const statsOf = (name, cls = currentClass) => (market[name] ? market[name][cls] : null);
const rentOf = (name, cls = currentClass) => (rents[name] ? rents[name][cls] : null);
const amOf = (name) => amenities[name] || null; // amenities are class-independent

function modeValue(name) {
  const stats = statsOf(name);
  if (currentMode === "trend") {
    if (!stats || stats.monthlyChangePct == null) return null;
    const r = fmtRate(stats.monthlyChangePct);
    return { v: stats.monthlyChangePct, text: r.text + "/mo", cls: r.cls, asc: true };
  }
  if (currentMode === "yield") {
    const rent = rentOf(name);
    if (!rent || rent.grossYieldPct == null) return null;
    return { v: rent.grossYieldPct, text: `${rent.grossYieldPct.toFixed(1)}%`, cls: "is-flat", asc: false };
  }
  if (currentMode === "amenities") {
    const am = amOf(name);
    if (!am) return null;
    return { v: am.scores.total, text: am.scores.total.toFixed(1), cls: "is-flat", asc: false };
  }
  const score = combinedScore(stats, amOf(name), rentOf(name));
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
  trend: () => `${CLASS_TITLE[currentClass]} · price trend · ${marketMeta.trendLabel || ""}`,
  yield: () => `${CLASS_TITLE[currentClass]} · gross rental yield`,
  amenities: () => "Amenity access · 0–10",
  combined: () => `${CLASS_TITLE[currentClass]} · opportunity rating · 0–100`,
};
const MODE_HEADINGS = {
  trend: () => `${CLASS_TITLE[currentClass]} — fastest-falling medians`,
  yield: () => `${CLASS_TITLE[currentClass]} — highest gross yields`,
  amenities: () => "Best-served areas",
  combined: () => `${CLASS_TITLE[currentClass]} — strongest ratings`,
};
const MODE_HINTS = {
  trend: () => `Where ${CLASS_LABEL[currentClass]} medians have dropped most — the cooling end of the market.`,
  yield: () => `Annual rent as a share of the ${CLASS_LABEL[currentClass]} median, from real bond lodgements.`,
  amenities: () => "Transit, schools and shopping access scored from mapped locations. Independent of property type.",
  combined: () => `Price momentum, rental yield and amenity access for ${CLASS_LABEL[currentClass]}, combined.`,
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
  openSuburb = null;

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
      suburbIndex.set(name, { layer, centroid: feature.properties.centroid });
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

function setClass(cls, keepOpen = true) {
  currentClass = cls;
  try { localStorage.setItem("propertyClass", cls); } catch { /* private mode */ }
  document.querySelectorAll("[id^=class-]").forEach((b) => {
    const active = b.id === `class-${cls}`;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  const reopen = keepOpen ? openSuburb : null;
  refreshMode();
  // Staying on the same suburb while flipping type is the whole point of the
  // control — rebuild the detail rather than dumping the viewer back to a list.
  if (reopen && statsOf(reopen)) showDetail(reopen);
}

function refreshMode() {
  if (!geoLayer) return;
  geoLayer.setStyle(styleFor);
  suburbIndex.forEach((entry, name) => {
    const stats = statsOf(name);
    const mv = modeValue(name);
    const price = stats && stats.medianValue ? `${fmtMoney(stats.medianValue)} median` : null;
    const line = [price, mv ? mv.text : "insufficient data"].filter(Boolean).join(" · ");
    entry.layer.unbindTooltip();
    entry.layer.bindTooltip(
      `<strong>${esc(name)}</strong><br><span class="tip-line">${CLASS_TITLE[currentClass]} · ${line}</span>`,
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
      `<p class="legend-note">${MODE_HINTS[currentMode]()}</p></div>`;
    el.addEventListener("toggle", () => { legendOpen = el.open; });
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    return el;
  };
  legendControl.addTo(map);
}

/* --- panel: ranked list -------------------------------------------------- */

function citySummaryHtml() {
  const all = [...suburbIndex.keys()];
  const cooling = all.filter((n) => { const s = statsOf(n); return s && s.monthlyChangePct != null && s.monthlyChangePct <= -0.25; }).length;
  const medPrice = median(all.map((n) => statsOf(n)?.medianValue).filter((v) => v != null));
  const medYield = median(all.map((n) => rentOf(n)?.grossYieldPct).filter((v) => v != null));
  const medAm = median(all.map((n) => amOf(n)?.scores.total).filter((v) => v != null));
  const cell = (value, label) =>
    `<div class="summary-cell"><div class="summary-value num">${value}</div><div class="summary-label">${label}</div></div>`;
  return `<div class="summary">
    ${cell(`${cooling}`, "Cooling areas")}
    ${cell(medPrice != null ? fmtMoney(medPrice) : "—", `Median ${CLASS_LABEL[currentClass]}`)}
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
    .map((name) => ({ name, mv: modeValue(name) }))
    .filter((x) => x.mv)
    .sort((a, b) => (a.mv.asc ? a.mv.v - b.mv.v : b.mv.v - a.mv.v))
    .slice(0, 15);

  const rows = ranked
    .map(({ name, mv }) => {
      const stats = statsOf(name), rent = rentOf(name), am = amOf(name);
      const meta = currentMode === "trend" && stats && stats.salesInWindow
        ? `${stats.salesInWindow} sales · ${fmtMoney(stats.medianValue)}`
        : currentMode === "yield" && rent
          ? `${rent.rentSample} bonds · $${rent.medianWeeklyRent}/wk`
          : currentMode === "amenities" && am
            ? `${am.facts.stationsIn} stations · ${am.facts.schoolsIn} schools`
            : stats ? fmtMoney(stats.medianValue) : "";
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

  const noData = ranked.length === 0
    ? `<p class="hint hint-quiet">No ${CLASS_LABEL[currentClass]} data for this measure. Try the other property type.</p>`
    : "";

  panelContent.innerHTML = `
    <h2 class="panel-heading">${MODE_HEADINGS[currentMode]()}</h2>
    <p class="hint">${CITIES[currentCity].label} · ${MODE_HINTS[currentMode]()}</p>
    ${citySummaryHtml()}
    <span class="eyebrow">Top ${ranked.length} · click for detail</span>
    <ol class="rank-list" id="opportunity-list">${rows}</ol>
    ${noData}
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
  openSuburb = null;
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
      <p class="hint hint-quiet">Too few bond lodgements for ${CLASS_LABEL[currentClass]} here to publish a rent median.</p>`;
  }
  const bedRows = Object.entries(rent.byBedrooms || {})
    .map(([k, v]) => `<tr><td>${/^\d+$/.test(k) ? `${k} bedroom` : esc(k)}</td><td class="right num">${v.count}</td><td class="right num strong">$${v.median}</td></tr>`)
    .join("");
  return `<span class="eyebrow">Rent &amp; yield</span>
    <div class="metrics">
      <div class="metric"><div class="metric-label">Median rent</div><div class="metric-value num">$${rent.medianWeeklyRent}<span class="unit">/wk</span></div></div>
      <div class="metric"><div class="metric-label">Gross yield</div><div class="metric-value num">${rent.grossYieldPct != null ? rent.grossYieldPct + "%" : "—"}</div></div>
      <div class="metric"><div class="metric-label">Bonds</div><div class="metric-value num">${rent.rentSample}</div></div>
    </div>
    <p class="hint hint-quiet">Measured at ${esc(rent.rentScope || "area")} level${rent.priceUsed ? `, against the ${CLASS_LABEL[currentClass]} median of ${fmtMoney(rent.priceUsed)}` : ""}. Gross — before strata, rates and vacancy.</p>
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

function salesSectionHtml(stats) {
  if (stats.sales && stats.sales.length) {
    const rows = stats.sales
      .map((sale) => `<tr><td class="num">${sale.date.slice(2)}</td><td>${esc(sale.address)}</td><td class="right num strong">${fmtMoney(sale.price)}</td></tr>`)
      .join("");
    return `<span class="eyebrow">Recent ${CLASS_NOUN[currentClass]} sales</span>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Address</th><th class="right">Price</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }
  if (stats.salesSummary) {
    const sum = stats.salesSummary;
    const prior = (sum.priorYears || [])
      .map((y) => `<tr><td class="num">${y.year}</td><td class="right num">${y.count ?? "—"}</td><td class="right num strong">${fmtMoney(y.median)}</td></tr>`)
      .join("");
    return `<span class="eyebrow">Sales · ${esc(sum.period)}</span>
      <div class="table-wrap"><table class="data-table"><tbody>
        <tr><td>${CLASS_TITLE[currentClass]} sold</td><td class="right num strong">${sum.count ?? "—"}</td></tr>
        <tr><td>Median</td><td class="right num strong">${fmtMoney(sum.median)}</td></tr>
      </tbody></table></div>
      <span class="eyebrow">Prior years · ABS, year to 30 June</span>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Year</th><th class="right">Sales</th><th class="right">Median</th></tr></thead>
        <tbody>${prior}</tbody></table></div>`;
  }
  return '<p class="hint hint-quiet">No sales detail available for this area.</p>';
}

function crossClassHtml(name) {
  const other = OTHER_CLASS[currentClass];
  const s = statsOf(name, other);
  if (!s || s.medianValue == null) return "";
  const rate = fmtRate(s.monthlyChangePct);
  return `<button class="cross-class" id="cross-class" type="button">
      <span class="cross-class-label">${CLASS_TITLE[other]} here</span>
      <span class="cross-class-value num">${fmtMoney(s.medianValue)}</span>
      <span class="cross-class-rate num ${rate.cls}">${s.monthlyChangePct == null ? "" : rate.text + "/mo"}</span>
      <span class="cross-class-go" aria-hidden="true">→</span>
    </button>`;
}

function showDetail(name) {
  const stats = statsOf(name);
  if (!stats) return;
  openSuburb = name;
  const am = amOf(name);
  const rent = rentOf(name);
  const rate = fmtRate(stats.monthlyChangePct);
  const rating = combinedScore(stats, am, rent);
  const longChange = stats.change12mPct ?? stats.change18mPct;
  const longLabel = stats.change12mPct != null ? "12 months" : "Since FY24";
  const longCls = longChange == null ? "is-flat" : longChange <= -0.5 ? "is-down" : longChange >= 0.5 ? "is-up" : "is-flat";

  panelContent.innerHTML = `
    <button class="back-btn" id="detail-back" type="button">← ${MODE_HEADINGS[currentMode]()}</button>
    <div class="detail-head">
      <div>
        <h2 class="detail-name">${esc(name)}</h2>
        <p class="detail-sub">${CITIES[currentCity].label} · ${CLASS_TITLE[currentClass]}</p>
      </div>
      ${rating != null
        ? `<div class="rating-chip" style="--chip-accent:${bucketColor(RATING_BUCKETS, rating)}">
             <span class="rating-chip-value num">${rating}</span>
             <span class="rating-chip-label">Rating</span>
           </div>`
        : ""}
    </div>

    <span class="eyebrow">${CLASS_TITLE[currentClass]} · price</span>
    <div class="metrics">
      <div class="metric"><div class="metric-label">Median</div><div class="metric-value num">${fmtMoney(stats.medianValue)}</div></div>
      <div class="metric"><div class="metric-label">Per month</div><div class="metric-value num ${rate.cls}">${rate.text}</div></div>
      <div class="metric"><div class="metric-label">${longLabel}</div><div class="metric-value num ${longCls}">${longChange == null ? "—" : (longChange > 0 ? "+" : "") + longChange + "%"}</div></div>
    </div>
    <p class="hint hint-quiet">As at ${esc(stats.medianAsOf || "latest period")}${stats.salesInWindow ? ` · ${stats.salesInWindow} sales in the window` : ""}.</p>
    ${crossClassHtml(name)}

    ${rentSectionHtml(rent)}
    ${mortgageSectionHtml(stats)}
    ${amenitySectionHtml(am)}

    <span class="eyebrow">Median history · ${CLASS_LABEL[currentClass]}</span>
    <div class="spark-card">
      ${sparklineSvg(stats.history)}
      ${stats.history && stats.history.length >= 2
        ? `<div class="spark-foot"><span class="num">${stats.history[0].month} · ${fmtMoney(stats.history[0].median)}</span><span class="num">${stats.history[stats.history.length - 1].month} · ${fmtMoney(stats.history[stats.history.length - 1].median)}</span></div>`
        : ""}
    </div>

    ${salesSectionHtml(stats)}
    ${provenanceHtml()}`;

  document.getElementById("detail-back").addEventListener("click", restoreDefaultPanel);
  const cross = document.getElementById("cross-class");
  if (cross) cross.addEventListener("click", () => setClass(OTHER_CLASS[currentClass]));
  bindMortgage(rent);
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
document.getElementById("class-houses").addEventListener("click", () => setClass("houses"));
document.getElementById("class-units").addEventListener("click", () => setClass("units"));
for (const m of ["trend", "yield", "amenities", "combined"]) {
  document.getElementById(`mode-${m}`).addEventListener("click", () => setMode(m));
}
document.getElementById("theme-toggle").addEventListener("click", () => {
  themePref = THEME_ORDER[(THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length];
  localStorage.setItem("theme", themePref);
  applyTheme();
});

applyTheme();
// Reflect the remembered property type in the control before first paint.
document.querySelectorAll("[id^=class-]").forEach((b) => {
  const active = b.id === `class-${currentClass}`;
  b.classList.toggle("is-active", active);
  b.setAttribute("aria-selected", String(active));
});
loadCity("sydney");
