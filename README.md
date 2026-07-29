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
the median value, trend, a price-history sparkline, sales detail and an
amenity breakdown. A search box and a Sydney/Brisbane switcher sit in the
header, plus a view switcher:

- **Price trend** — the green/red choropleth above.
- **Amenities** — blue choropleth of a 0–10 amenity access score built from
  real OpenStreetMap locations: transit stations (rail/metro/busway/ferry),
  schools, shopping centres and supermarkets.
- **Rating** — 0–100 combined opportunity rating: 60% price momentum
  (falling medians score higher) + 40% amenity access.

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
- Nothing here is financial advice — it's a map of public records.

## Project layout

```
server.js                     tiny static server (npm start)
scripts/fetch-nsw-sales.sh    download NSW VG PSI files -> scripts/raw-nsw/
scripts/build-market-sydney.js  parse sales -> site/data/sydney/market.json
scripts/fetch-brisbane-data.js  ABS boundaries+medians, QGSO profiles -> scripts/raw-brisbane/
scripts/build-market-brisbane.js -> site/data/brisbane/market.json
scripts/build-suburbs.js      rebuild Sydney boundary file
scripts/qgso-sa2-ids.json     QGSO region ids for SA2 profile requests
site/                         the website (Leaflet, no build step)
site/data/<city>/             committed data the site loads
```
