#!/bin/bash
# KernTrip — build & deploy
set -e
cd "$(dirname "$0")"

grep -o 'v[0-9][0-9.]*[a-z]*' src/html/template.html | head -1

node build.js

# Browser version next to fuchs.js (drop a font to test)
cp -f glyphs/KernTrip.glyphsPlugin/Contents/Resources/ui.html index.html
cp -f glyphs/KernTrip.glyphsPlugin/Contents/Resources/fuchs.js fuchs.js

rm -f KernTrip.zip
zip -qr KernTrip.zip glyphs/ -x "*.DS_Store"

# Install into Glyphs 3 (reload the plugin in Glyphs afterwards)
cp -R glyphs/KernTrip.glyphsPlugin ~/Library/Application\ Support/Glyphs\ 3/Plugins/

echo "KernTrip built -> index.html / KernTrip.zip / installed into Glyphs 3 Plugins"
