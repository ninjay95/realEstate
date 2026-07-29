#!/usr/bin/env bash
# Downloads NSW Fair Trading monthly rental bond lodgement files (the last 12
# months). Each file lists every bond lodged that month: postcode, dwelling
# type, bedrooms and weekly rent — real signed-lease rents.
#
# Source: https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data
# Files land in scripts/raw-nsw/rents/.
#
# Usage: bash scripts/fetch-nsw-rents.sh

set -u
cd "$(dirname "$0")"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
OUT="raw-nsw/rents"
mkdir -p "$OUT"

# Files live under a publish-month folder, one month after the data month:
#   .../noindex/2026-07/rentalbond_lodgements_june_2026.xlsx
node -e '
  const names = ["january","february","march","april","may","june","july","august",
    "september","october","november","december"];
  const now = new Date();
  for (let back = 1; back <= 12; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const pub = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const pubFolder = `${pub.getUTCFullYear()}-${String(pub.getUTCMonth() + 1).padStart(2, "0")}`;
    console.log(`${pubFolder} rentalbond_lodgements_${names[d.getUTCMonth()]}_${d.getUTCFullYear()}.xlsx`);
  }
' | while read -r folder file; do
  dest="$OUT/$file"
  if [ -s "$dest" ]; then echo "have $file"; continue; fi
  url="https://www.nsw.gov.au/sites/default/files/noindex/$folder/$file"
  code=$(curl -sL --max-time 180 -A "$UA" -w "%{http_code}" -o "$dest" "$url")
  if [ "$code" = "200" ] && [ -s "$dest" ]; then
    echo "ok   $file ($(wc -c < "$dest") bytes)"
  else
    rm -f "$dest"
    echo "MISS $file (status $code)"
  fi
  sleep 1
done
echo "Rent files: $(ls "$OUT" | wc -l)"
