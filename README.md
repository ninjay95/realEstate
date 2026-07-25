# Suburb Opportunity Map

A local-first website that maps Sydney suburbs and colours them by recent
median-price trend:

- **Green** — median values have been **falling** (potential buying
  opportunities). The monthly drop rate is shown as a label on top of each
  suburb (e.g. `▼ 1.4%/mo`).
- **Grey** — flat (±0.25%/mo).
- **Red** — still **expensive**: flat-to-rising or climbing.

Clicking a suburb (or an entry in the "Top opportunities" panel) opens a
detail view with the estimated median value, monthly and 12-month trend, a
24-month price sparkline, and a list of recent sales. There's also a suburb
search box in the header.

## Run it

Requires Node.js (no npm dependencies).

```bash
npm start
```

Then open <http://localhost:5173>.

## Data

- **Boundaries** — real suburb polygons for the Sydney metro area, filtered
  from the PSMA NSW locality boundaries published in
  [GeoJson-Data](https://github.com/tonywr71/GeoJson-Data)
  (`suburb-2-nsw.geojson`). `site/data/suburbs.geojson` is committed; to
  rebuild it (e.g. to change the bounding box or switch city):

  ```bash
  curl -L -o scripts/nsw-suburbs-raw.geojson https://raw.githubusercontent.com/tonywr71/GeoJson-Data/master/suburb-2-nsw.geojson
  npm run build:suburbs
  ```

- **Sales & valuations** — `site/data/market.json` is **generated sample
  data** (deterministic per suburb, produced by
  `scripts/generate-market.js`). It is *not* real market data. Regenerate
  with:

  ```bash
  npm run build:market
  ```

### Plugging in real data

The site only reads `site/data/market.json`; nothing else needs to change.
Replace the generator with anything that writes the same shape:

```jsonc
{
  "generatedAt": "2026-07-25",
  "suburbs": {
    "Marrickville": {
      "medianValue": 1480000,        // current estimated median (AUD)
      "monthlyChangePct": -1.32,     // avg %/month over the last 6 months (drives the colour + label)
      "change12mPct": -9.8,
      "history": [ { "month": "2024-08", "median": 1610000 } /* ... 24 entries */ ],
      "sales": [
        { "date": "2026-07-03", "price": 1425000, "address": "12 Example St",
          "beds": 3, "baths": 2, "type": "House" }
      ]
    }
  }
}
```

Candidate real sources: NSW Valuer General bulk property sales data (free
CSV downloads), Domain API, CoreLogic, or realestate.com.au market data.

## Project layout

```
server.js                  tiny static server (npm start)
scripts/build-suburbs.js   filter NSW boundaries -> site/data/suburbs.geojson
scripts/generate-market.js sample market data -> site/data/market.json
site/index.html            page shell
site/style.css             styling (light + dark via prefers-color-scheme)
site/app.js                Leaflet map, choropleth, labels, legend, panel
site/data/                 committed data the site loads
```
