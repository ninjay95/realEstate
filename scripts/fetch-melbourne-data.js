// Downloads the Victorian source files for Melbourne into scripts/raw-melbourne/:
//
//  1. Victorian Property Sales Report — median house and median unit by suburb,
//     one legacy .xls per published quarter (land.vic.gov.au, CC BY 4.0).
//     Each release carries five quarters, so the published releases overlap
//     into one continuous quarterly series.
//  2. Rental Report — moving annual median rents by suburb, one .xlsx per
//     quarter (DFFH, sourced from Residential Tenancies Bond Authority data).
//
// Resource URLs come from the data.vic CKAN API rather than being hardcoded,
// so a new quarter is picked up automatically.
//
// Usage: node scripts/fetch-melbourne-data.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RAW = path.join(__dirname, "raw-melbourne");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATASETS = {
  house: "victorian-property-sales-report-median-house-by-suburb",
  unit: "victorian-property-sales-report-median-unit-by-suburb",
  rent: "rental-report-quarterly-moving-annual-rents-by-suburb",
};

fs.mkdirSync(path.join(RAW, "sales"), { recursive: true });
fs.mkdirSync(path.join(RAW, "rents"), { recursive: true });

async function resourcesFor(dataset) {
  const res = await fetch(`https://discover.data.vic.gov.au/api/3/action/package_show?id=${dataset}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`CKAN ${res.status} for ${dataset}`);
  const body = await res.json();
  if (!body.success) throw new Error(`CKAN said no for ${dataset}`);
  return body.result.resources || [];
}

// land.vic.gov.au sits behind a WAF that rejects Node's fetch outright (it
// blocks on the TLS fingerprint, so no combination of headers gets through)
// while curl is served normally. The CKAN API above is fine either way.
function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) return "have";
  try {
    const code = execFileSync("curl", [
      "-sL", "--max-time", "180", "-A", UA, "-o", dest, "-w", "%{http_code}", url,
    ], { encoding: "utf8" }).trim();
    if (code !== "200") { fs.rmSync(dest, { force: true }); return `MISS ${code}`; }
    const size = fs.statSync(dest).size;
    if (size < 5000) { fs.rmSync(dest, { force: true }); return `MISS tiny (${size}b)`; }
    return `ok ${Math.round(size / 1024)}KB`;
  } catch (e) {
    fs.rmSync(dest, { force: true });
    return `MISS ${String(e).slice(0, 60)}`;
  }
}

(async () => {
  // --- sales: every published quarter, both dwelling classes ---------------
  for (const cls of ["house", "unit"]) {
    const resources = await resourcesFor(DATASETS[cls]);
    console.log(`${cls}: ${resources.length} quarterly releases`);
    for (const r of resources) {
      if (!/\.xlsx?$/i.test(r.url)) continue;
      const file = `${cls}-${path.basename(r.url).toLowerCase()}`;
      const status = download(r.url, path.join(RAW, "sales", file));
      console.log(`  ${file}: ${status}`);
      await sleep(400);
    }
  }

  // --- rents: the most recent few quarters is plenty for a median ----------
  const rentResources = (await resourcesFor(DATASETS.rent)).filter((r) => /excel|xlsx/i.test(r.url + r.format));
  const latest = rentResources.slice(-2); // current + previous, in case one is malformed
  console.log(`rents: ${rentResources.length} releases, taking ${latest.length} most recent`);
  for (const r of latest) {
    const file = `${path.basename(r.url).replace(/[^a-z0-9.-]/gi, "-")}.xlsx`;
    const status = download(r.url, path.join(RAW, "rents", file));
    console.log(`  ${file}: ${status}`);
    await sleep(400);
  }
  console.log("Melbourne raw data fetched.");
})().catch((e) => { console.error(e); process.exit(1); });
