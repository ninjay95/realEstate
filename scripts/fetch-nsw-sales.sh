#!/usr/bin/env bash
# Downloads NSW Valuer General bulk Property Sales Information (PSI) files
# covering roughly the last 24 months, and extracts all .DAT files into
# scripts/raw-nsw/dat/.
#
# Source: https://www.valuergeneral.nsw.gov.au (open access, CC BY-NC-ND 4.0)
# Yearly archives cover completed years; the current year is published as
# weekly files (Monday-dated).
#
# Usage: bash scripts/fetch-nsw-sales.sh

set -u
cd "$(dirname "$0")"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
BASE="https://www.valuergeneral.nsw.gov.au/__psi"
OUT="raw-nsw"
mkdir -p "$OUT/zips" "$OUT/dat"

fetch() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then return 0; fi
  for attempt in 1 2 3; do
    code=$(curl -s --max-time 300 -A "$UA" -w "%{http_code}" -o "$dest" "$url")
    if [ "$code" = "200" ] && [ -s "$dest" ]; then
      echo "ok   $url ($(wc -c < "$dest") bytes)"
      return 0
    fi
    rm -f "$dest"
    sleep 2
  done
  echo "MISS $url (last status $code)"
  return 1
}

# Yearly archives for the two previous calendar years
for year in 2024 2025; do
  fetch "$BASE/yearly/$year.zip" "$OUT/zips/$year.zip"
done

# Weekly files for the current year: every Monday from Jan up to today
node -e '
  const start = new Date(Date.UTC(2026, 0, 1));
  const now = new Date();
  const d = new Date(start);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const out = [];
  while (d <= now) {
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  console.log(out.join("\n"));
' | while read -r stamp; do
  fetch "$BASE/weekly/$stamp.zip" "$OUT/zips/w$stamp.zip"
  sleep 0.4
done

# Extract: outer zips, then any nested zips, keep only .DAT files
echo "Extracting..."
TMPX="$OUT/extract-tmp"
rm -rf "$TMPX"; mkdir -p "$TMPX"
for z in "$OUT"/zips/*.zip; do
  name=$(basename "$z" .zip)
  dir="$TMPX/$name"
  mkdir -p "$dir"
  unzip -oq "$z" -d "$dir" 2>/dev/null
done
# nested zips (yearly archives contain weekly zips)
find "$TMPX" -name "*.zip" | while read -r inner; do
  unzip -oq "$inner" -d "$(dirname "$inner")/$(basename "$inner" .zip)_x" 2>/dev/null
done
find "$TMPX" -iname "*.dat" -exec mv -f {} "$OUT/dat/" \;
rm -rf "$TMPX"
echo "DAT files: $(ls "$OUT/dat" | wc -l)"
