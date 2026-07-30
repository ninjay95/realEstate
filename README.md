# Suburb Opportunity Map

A local-first website that maps **Sydney** and **Brisbane** suburbs and
colours them by their **real** recent median-price trend:

- **Green** — median values have been **falling** (potential buying
  opportunities). The monthly drop rate is shown as a label on top of each
  suburb (e.g. `▼ 1.4%/mo`).
- **Grey** — flat (±0.25%/mo). Areas with too few sales to compute a
  reliable median are shown dashed and pale.
- **Red** — still **expensive**: flat-to-rising or climbing.

Clicking an area (or an entry in the ranked panel) opens a detail view with
the median value, trend, a price-history sparkline, sales detail, an amenity
breakdown, and a **mortgage calculator** prefilled with that area's median
price. The calculator shows the principal-and-interest repayment plus how much
of it the area's real median rent would cover — your deposit, rate and term
assumptions carry across suburbs. A search box and a Sydney/Brisbane switcher sit in the
header, plus a view switcher:

- **Trend** — the green/red choropleth above.
- **Yield** — orange choropleth of gross rental yield (annual rent as a % of
  the median price), from real rental-bond lodgements.
- **Amenities** — blue choropleth of a 0–10 amenity access score built from
  real OpenStreetMap locations: transit stations (rail/metro/busway/ferry),
  schools, shopping centres and supermarkets.
- **Rating** — 0–100 combined opportunity rating: **40% price momentum**
  (falling medians score higher) + **30% rental yield** + **30% amenity
  access**. If a component is missing for an area the remaining weights are
  renormalised; price momentum is required.

## Run it

Requires Node.js (no npm dependencies). The repo ships with pre-built data,
so this is all you need:

```bash
npm start
```

Then open <http://localhost:5173>.

## Data sources (all free/open government data)

### Sydney — individual sales records

- **Boundaries**: PSMA NSW locality polygons filtered to the Sydney metro
  area (via [GeoJson-Data](https://github.com/tonywr71/GeoJson-Data)).
- **Sales**: [NSW Valuer General bulk Property Sales Information](https://www.valuergeneral.nsw.gov.au/design/bulk_psi_content/bulk_psi)
  — every property sale in NSW, updated weekly (open access, CC BY-NC-ND 4.0).
- **Method**: residential sales grouped by suburb; median of a rolling
  3-month window per month (minimum 10 sales per window); the trend is the
  annualised %/month change of that median over the last 6 months. The
  detail panel lists the suburb's actual most recent sales.

Rebuild:

```bash
npm run fetch:sydney   # downloads ~24 months of PSI files (~40 MB)
npm run build:sydney
```

### Brisbane — SA2 medians

Queensland does not publish individual sales as open data (QVAS is a paid
product), so Brisbane uses the two best open aggregates, at ABS SA2 level
(broadly suburb-sized; official ASGS 2021 boundaries from the ABS ArcGIS
service):

- **Current medians + sales counts**: [QGSO Queensland Housing Profiles](https://statistics.qgso.qld.gov.au/hpw/profiles)
  — residential dwelling sales from the QVAS database, 12 months ending
  Dec 2025, split detached/attached (CC BY 4.0, © State of Queensland).
- **Historical medians**: [ABS Data by region](https://www.abs.gov.au/)
  (`ABS_REGIONAL_ASGS2021` API dataset) — annual medians of established
  house and attached-dwelling transfers per SA2, year ended 30 June.
- **Method**: the QVAS 12-month median is compared like-for-like against
  the ABS FY2024 median for the same dwelling class (detached preferred,
  attached fallback), annualised over the 18 months between the two
  periods' midpoints and expressed as %/month. Individual sale records
  aren't available, so the detail panel shows sales counts and medians by
  dwelling type and year instead.

Rebuild:

```bash
npm run fetch:brisbane   # ABS API + ~250 QGSO profile requests (~10 min, throttled)
npm run build:brisbane
```

### Rents & yields

- **Sydney** — [NSW Fair Trading rental bond lodgements](https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data):
  every bond lodged with Fair Trading, one XLSX per month, with postcode,
  dwelling type, bedrooms and weekly rent. ~227,000 usable lodgements over the
  last 10 published months. **Rents are only published at postcode level**, so
  a suburb inherits the median of the postcode(s) its sales sit in — suburbs
  sharing a postcode share a rent median (the panel labels the scope).
- **Brisbane** — median rents per SA2 from the same
  [QGSO Housing Profiles](https://statistics.qgso.qld.gov.au/hpw/profiles)
  service (`MEDIANRENT` topic), derived by Queensland Treasury from
  **Residential Tenancies Authority** bond lodgements. Published as 1/2-bedroom
  flat-unit and 3/4-bedroom house medians; we combine the categories for the
  area's dominant class weighted by lodgement count.
- **Yield** = median weekly rent × 52 ÷ median sale price, matched to the same
  dwelling class (houses vs units) on both sides. Minimum 10 lodgements.

Rebuild:

```bash
npm run fetch:rents-sydney     # ~7 MB of monthly XLSX files
npm run fetch:rents-brisbane   # ~250 QGSO requests (~7 min, throttled)
npm run build:rents
```

### Amenities (both cities)

Locations come from **OpenStreetMap** (© OpenStreetMap contributors, ODbL)
via the Overpass API: `railway=station` / `public_transport=station` /
`amenity=bus_station` / `amenity=ferry_terminal`, `amenity=school`,
`shop=mall` and `shop=supermarket`. Each suburb gets 0–10 scores:

- **Transit**: stations inside the boundary (2+ → 10, 1 → 8.5), else graded
  by distance from the suburb centroid to the nearest station.
- **Schools**: count inside the boundary (3+ → 10), else nearest distance.
- **Shopping**: 70% shopping-centre proximity + 30% supermarket count.

The scores are documented heuristics over real locations; the underlying
facts (nearest station name/distance, counts) are shown in the detail panel.

Rebuild:

```bash
npm run fetch:amenities   # Overpass API, throttled per category
npm run build:amenities
```

## Honest-data notes

- Both trends are computed from **real transaction medians**, but suburb
  medians are noisy: composition shifts (more units selling than houses in
  a given window) move the median without prices changing. The rolling
  window and the 10-sale minimum reduce but don't eliminate this.
- The two cities' trend windows differ (6 months for Sydney, 18 months for
  Brisbane) because that's what each state's open data supports. The legend
  and panels label the window in use.
- Yields are **gross**, not net: they ignore strata/body-corporate fees,
  council rates, insurance, management fees and vacancy. Net yields are
  typically 1–1.5 percentage points lower, and more for high-strata units.
- Sydney rents are postcode-level while prices are suburb-level, so a
  small-suburb yield can be skewed by neighbours sharing its postcode. Rent
  and price periods also differ slightly (rents to mid-2026, Brisbane prices
  to Dec 2025).
- The mortgage calculator is a plain amortisation of **your own** inputs, not a
  quote or a rate we source from anywhere. It covers principal and interest
  only — no stamp duty, rates, strata, insurance or lenders mortgage insurance
  — so a real cost of holding is higher than the figure shown.
- Nothing here is financial advice — it's a map of public records.

## Technology, and moving off GitHub Pages

The site is **plain HTML, CSS and vanilla JavaScript** with Leaflet vendored
into `site/vendor/`. There is no framework, no build step, no bundler, no npm
dependencies at runtime, and no server-side code. That is a deliberate choice
for portability: the entire website is the `site/` folder, and every asset
path in it is relative.

Migrating to any other host is a copy:

| Host | How |
|---|---|
| Netlify | drag `site/` onto the deploy area, or connect the repo with publish directory `site` and no build command |
| Vercel | import the repo, framework preset "Other", output directory `site` |
| Cloudflare Pages | connect the repo, build output directory `site` |
| S3 + CloudFront | `aws s3 sync site/ s3://your-bucket --delete` |
| Any VPS (nginx/Apache) | copy `site/` into the web root |
| Own domain on Pages | add a `CNAME` file, or set the custom domain in repo settings |

The only external runtime requests are the CARTO basemap tiles. Everything
else — Leaflet, all data, all styling — is served from the same origin, so the
site also works behind a firewall and renders identically offline apart from
the basemap. If you ever need to drop CARTO too, swap the tile URL in
`site/app.js` for any other tile provider (or self-host tiles).

Because the data is pre-built JSON, adding a backend later is optional rather
than required: the fetch/build scripts can run anywhere on a schedule and just
commit or upload new files.

## Where the data comes from and where it lives

Every number on the map traces to one of these. Nothing is estimated or
synthesised.

| Signal | Source (all free/open) | Fetched into (gitignored) | Served from (committed) |
|---|---|---|---|
| Sydney boundaries | PSMA NSW localities via GeoJson-Data | `scripts/nsw-suburbs-raw.geojson` | `site/data/sydney/suburbs.geojson` |
| Sydney prices & sales | NSW Valuer General bulk PSI (weekly `.DAT`) | `scripts/raw-nsw/` | `site/data/sydney/market.json` |
| Sydney rents | NSW Fair Trading bond lodgements (monthly `.xlsx`) | `scripts/raw-nsw/rents/` | `site/data/sydney/rents.json` |
| Brisbane boundaries | ABS ASGS 2021 SA2 (ArcGIS API) | — (written directly) | `site/data/brisbane/suburbs.geojson` |
| Brisbane prices | QGSO Housing Profiles (QVAS) + ABS Data by region | `scripts/raw-brisbane/` | `site/data/brisbane/market.json` |
| Brisbane rents | RTA bond lodgements via QGSO Housing Profiles | `scripts/raw-brisbane/qgso-rents.json` | `site/data/brisbane/rents.json` |
| Amenities (both) | OpenStreetMap via Overpass API | `scripts/raw-amenities/` | `site/data/<city>/amenities.json` |

The site is **static** — it only ever reads the committed JSON/GeoJSON in
`site/data/`, so it works offline and on GitHub Pages with no backend and no
API keys. Raw downloads (~50 MB) stay local and gitignored; only the compact
built files are committed. Nothing is stored anywhere else: no database, no
server, no third-party service, and no personal data of any kind.

## Project layout

```
server.js                     tiny static server (npm start)
scripts/fetch-nsw-sales.sh    download NSW VG PSI files -> scripts/raw-nsw/
scripts/build-market-sydney.js  parse sales -> site/data/sydney/market.json
scripts/fetch-brisbane-data.js  ABS boundaries+medians, QGSO profiles -> scripts/raw-brisbane/
scripts/build-market-brisbane.js -> site/data/brisbane/market.json
scripts/build-suburbs.js      rebuild Sydney boundary file
scripts/fetch-nsw-rents.sh    download NSW bond lodgement xlsx -> scripts/raw-nsw/rents/
scripts/fetch-rents-brisbane.js QGSO median rents -> scripts/raw-brisbane/qgso-rents.json
scripts/build-rents.js        rents + gross yields -> site/data/<city>/rents.json
scripts/fetch-amenities.js    OSM/Overpass points -> scripts/raw-amenities/
scripts/build-amenities.js    amenity scores -> site/data/<city>/amenities.json
scripts/lib/xlsx-lite.js      dependency-free xlsx reader (for the bond files)
scripts/qgso-sa2-ids.json     QGSO region ids for SA2 profile requests
site/index.html               page shell
site/style.css                design tokens + chrome styles (light & dark)
site/app.js                   map, views, ranked lists, detail inspector
site/vendor/leaflet/          vendored Leaflet (no CDN dependency)
site/data/<city>/             committed data the site loads
```

## Design notes

- **Two type roles**: a UI grotesque for interface text, and a monospace face
  with tabular numerals for every figure — prices, yields, counts, dates — so
  columns align and digits never reflow. No webfont is loaded, which keeps the
  page fast, offline-capable and free of third-party requests.
- **Cool slate neutrals** so the data colours (which carry meaning) advance and
  the chrome recedes. All interface text clears WCAG AA 4.5:1 in both themes.
- **Three themes states**: follow system, force light, force dark — the toggle
  persists in `localStorage` and the basemap follows it.
- **Colour is never the only encoding**: every shaded area also carries its
  value as a map label, and ranked-list rows repeat the map colour as a swatch
  beside the name and number.
