#!/bin/sh
# Web kökünü yayına hazırlar: statik dosyaları önceden sıkıştırır.
set -eu
SITE="$1"

find "$SITE" -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' -o -name '*.json' -o -name '*.webmanifest' -o -name '*.svg' -o -name '*.otf' -o -name '*.ttf' -o -name '*.html' \) \
  -exec sh -c 'brotli -q 11 -k -f "$1" && zstd -19 -q -k -f "$1"' _ {} \;
