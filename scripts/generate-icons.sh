#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_MARK="${ROOT_DIR}/frontend/public/vera-mark.png"
DESKTOP_BUILD_DIR="${ROOT_DIR}/desktop/build"
ICONSET="${DESKTOP_BUILD_DIR}/Vera.iconset"
APP_ICON="${DESKTOP_BUILD_DIR}/icon.png"

mkdir -p "${DESKTOP_BUILD_DIR}" "${ICONSET}"

magick -size 1024x1024 xc:none \
  \( -size 1024x1024 xc:none \
    -fill '#000000' \
    -draw 'roundrectangle 48,48 976,976 210,210' \
  \) \
  -compose over -composite \
  \( "${SOURCE_MARK}" -shave 16x16 -resize 820x820 \) \
  -gravity center -compose over -composite \
  "${APP_ICON}"

sips -z 180 180 "${APP_ICON}" --out "${ROOT_DIR}/frontend/src/app/apple-touch-icon.png" >/dev/null
cp "${APP_ICON}" "${ROOT_DIR}/frontend/src/app/icon.png"

if sips -z 32 32 "${APP_ICON}" --out /tmp/vera-favicon.png >/dev/null &&
  sips -s format ico /tmp/vera-favicon.png --out "${ROOT_DIR}/frontend/src/app/favicon.ico" >/dev/null 2>&1; then
  true
else
  echo "warning: favicon.ico generation is unsupported on this host" >&2
fi

rm -rf "${ICONSET}"
mkdir -p "${ICONSET}"
sips -z 16 16 "${APP_ICON}" --out "${ICONSET}/icon_16x16.png" >/dev/null
sips -z 32 32 "${APP_ICON}" --out "${ICONSET}/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "${APP_ICON}" --out "${ICONSET}/icon_32x32.png" >/dev/null
sips -z 64 64 "${APP_ICON}" --out "${ICONSET}/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "${APP_ICON}" --out "${ICONSET}/icon_128x128.png" >/dev/null
sips -z 256 256 "${APP_ICON}" --out "${ICONSET}/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "${APP_ICON}" --out "${ICONSET}/icon_256x256.png" >/dev/null
sips -z 512 512 "${APP_ICON}" --out "${ICONSET}/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "${APP_ICON}" --out "${ICONSET}/icon_512x512.png" >/dev/null
sips -z 1024 1024 "${APP_ICON}" --out "${ICONSET}/icon_512x512@2x.png" >/dev/null
iconutil -c icns "${ICONSET}" -o "${DESKTOP_BUILD_DIR}/icon.icns"
rm -rf "${ICONSET}"

echo "Generated desktop/build/icon.icns and web icon assets."
