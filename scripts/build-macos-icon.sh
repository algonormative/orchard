#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
source="$root/crates/orchard-desktop/icons/lemon-orchard-1024.png"
output=${1:?Usage: build-macos-icon.sh OUTPUT.icns}
case "$output" in /*) ;; *) output="$(pwd -P)/$output" ;; esac
test -f "$source" || { echo "missing app icon source: $source" >&2; exit 64; }
width=$(sips -g pixelWidth "$source" | awk '/pixelWidth:/ { print $2 }')
height=$(sips -g pixelHeight "$source" | awk '/pixelHeight:/ { print $2 }')
test "$width" = 1024 && test "$height" = 1024 || { echo 'app icon source must be 1024 x 1024 PNG' >&2; exit 64; }
work=$(mktemp -d "${TMPDIR:-/tmp}/orchard-icon.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
iconset="$work/Orchard.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -s format png -z "$double" "$double" "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$output"
test -s "$output"
