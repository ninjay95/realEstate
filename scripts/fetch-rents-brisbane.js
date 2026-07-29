// Fetches real median weekly rents per Brisbane SA2 from the QGSO Housing
// Profiles service (MEDIANRENT topic). Source data is Residential Tenancies
// Authority (RTA) rental bond lodgements, aggregated by Queensland Treasury;
// medians are only published where there are 10+ lodgements in the period.
//
// Output: scripts/raw-brisbane/qgso-rents.json (incremental; safe to re-run)
// Usage: node scripts/fetch-rents-brisbane.js

const fs = require("fs");
const path = require("path");

const RAW = path.join(__dirname, "raw-brisbane");
const GEO = path.join(__dirname, "..", "site", "data", "brisbane", "suburbs.geojson");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(RAW, { recursive: true });

// Columns in the QGSO rent table, in order (lodgement counts then medians).
const COLS = ["unit1", "unit2", "house3", "house4"];

function parseRentReport(html, regionName) {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xa0;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const period = (text.match(/12 months ending (\d+ \w+ \d{4})/) || [])[1] || null;
  const after = text.split("— $ per week —")[1];
  if (!after) return { period, ok: false };
  const upto = after.split(" Queensland ")[0];
  const idx = upto.indexOf(regionName);
  if (idx < 0) return { period, ok: false };
  const tail = upto.slice(idx + regionName.length).trim();
  // ". ." marks not-applicable, "n.a." not-available; both -> null
  const tokens = tail.replace(/\. \./g, "NA").split(" ").filter(Boolean);
  const nums = tokens.slice(0, 8).map((t) => {
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  });
  if (nums.length < 8) return { period, ok: false };
  const out = { period, ok: true, lodgements: {}, medianRent: {} };
  COLS.forEach((c, i) => { out.lodgements[c] = nums[i]; });
  COLS.forEach((c, i) => { out.medianRent[c] = nums[i + 4]; });
  return out;
}

(async () => {
  const idMap = JSON.parse(fs.readFileSync(path.join(__dirname, "qgso-sa2-ids.json"), "utf8"));
  const geo = JSON.parse(fs.readFileSync(GEO, "utf8"));
  const names = geo.features.map((f) => f.properties.name);
  const outPath = path.join(RAW, "qgso-rents.json");
  const store = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
  const todo = names.filter((n) => !(n in store));
  console.log(`QGSO rents: ${names.length} SA2s, ${todo.length} to fetch`);
  let done = 0, misses = 0;
  for (const name of todo) {
    const id = idMap[name];
    if (!id) { store[name] = { ok: false, reason: "no QGSO id" }; misses++; continue; }
    const body = new URLSearchParams({
      p_reg: id, p_comp_regtype: "S", p_comp_reg: "", p_topic_group: "ALL",
      p_rep_date: "", p_ref: "", p_maploaded_1: "Y", p_maploaded_2: "N",
      p_flashversion: "n.a.", p_reptyp: "RES", p_regtype: "SA2_21",
      p_user_region_name: "", p_comp_reg_list: "S", p_user_region_name_comp: "",
      p_topic_group_all: "ALL", p_topic: "MEDIANRENT", p_format: "html",
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
      const parsed = parseRentReport(await res.text(), name);
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
  console.log(`\nQGSO rents: done, ${misses} misses of ${todo.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
