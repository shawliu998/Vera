#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${ROOT_DIR}/desktop"
DIST_DIR="${DESKTOP_DIR}/dist"
DESKTOP_VERSION="$(node -p "require('${DESKTOP_DIR}/package.json').version")"

echo "==> Building Vera connected backend"
npm run build --prefix "${ROOT_DIR}/backend"

echo "==> Verifying Vera connected frontend"
(cd "${ROOT_DIR}/frontend" && ./node_modules/.bin/tsc --noEmit)
(cd "${ROOT_DIR}/frontend" && npm run lint -- \
  src/app/components/agent/AgentTaskWorkspace.tsx \
  src/app/lib/agentClient.ts)
npm run build --prefix "${ROOT_DIR}/frontend" -- --webpack

echo "==> Installing Electron packaging dependencies"
npm ci --prefix "${DESKTOP_DIR}"

echo "==> Verifying connected desktop security and startup"
npm run test:connected --prefix "${DESKTOP_DIR}"

echo "==> Packaging unsigned local macOS client"
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac --prefix "${DESKTOP_DIR}"

PACKAGED_APP="${DIST_DIR}/mac-${HOSTTYPE:-arm64}/Vera.app"
if [ ! -d "${PACKAGED_APP}" ]; then
  PACKAGED_APP="$(find "${DIST_DIR}" -maxdepth 2 -type d -name Vera.app -print -quit)"
fi
if [ -z "${PACKAGED_APP}" ] || [ ! -d "${PACKAGED_APP}" ]; then
  echo "Vera.app was not produced." >&2
  exit 1
fi

echo "==> Verifying packaged Vera.app"
VERA_PACKAGED_APP_PATH="${PACKAGED_APP}" npm run test:connected-smoke --prefix "${DESKTOP_DIR}"

echo "==> Generating checksums"
(cd "${DIST_DIR}" && shasum -a 256 \
  "Vera-Connected-${DESKTOP_VERSION}-"*.dmg \
  "Vera-Connected-${DESKTOP_VERSION}-"*.zip \
  > "Vera-Connected-${DESKTOP_VERSION}-SHA256SUMS.txt")

echo "==> Connected desktop artifacts"
find "${DIST_DIR}" -maxdepth 2 -type f -print | sort
