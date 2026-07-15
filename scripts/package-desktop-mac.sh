#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${ALETHEIA_DESKTOP_BACKEND_PORT:-43761}"
FRONTEND_PORT="${ALETHEIA_DESKTOP_FRONTEND_PORT:-43760}"
API_BASE="http://127.0.0.1:${BACKEND_PORT}"
DESKTOP_VERSION="$(node -p "require('${ROOT_DIR}/desktop/package.json').version")"
RELEASE_SIGNING="${VERA_RELEASE_SIGNING:-false}"
DIST_DIR="${ROOT_DIR}/desktop/dist"

if [ "${RELEASE_SIGNING}" != "false" ] && [ "${RELEASE_SIGNING}" != "true" ]; then
  echo "VERA_RELEASE_SIGNING must be exactly true or false." >&2
  exit 1
fi

if [ -n "${ALETHEIA_MAC_BUILD_MODE:-}" ]; then
  echo "ALETHEIA_MAC_BUILD_MODE is no longer used; use VERA_RELEASE_SIGNING=true for a release build." >&2
  exit 1
fi

mkdir -p "${DIST_DIR}"
find "${DIST_DIR}" -maxdepth 1 -type f -name 'Aletheia-*' -delete
find "${DIST_DIR}" -maxdepth 1 -type f -name "Vera-${DESKTOP_VERSION}-*" -delete

echo "==> Checking macOS signing mode"
(
  cd "${ROOT_DIR}/desktop"
  VERA_RELEASE_SIGNING="${RELEASE_SIGNING}" npm run signing:preflight
)

echo "==> Verifying Vera P0 backend source gates"
(
  cd "${ROOT_DIR}/backend"
  npm run test:workspace:p0-client
)

echo "==> Building backend"
(
  cd "${ROOT_DIR}/backend"
  npm run build
)

echo "==> Verifying Vera P0 frontend source gates"
(
  cd "${ROOT_DIR}/frontend"
  npm run test:p0-client
)

echo "==> Building frontend for desktop API ${API_BASE}"
(
  cd "${ROOT_DIR}/frontend"
  export NEXT_PUBLIC_API_BASE_URL="${API_BASE}"
  export NEXT_PUBLIC_ALETHEIA_LOCAL_CLIENT="true"
  # Desktop receives its per-launch token through the trusted bridge. Never
  # embed an ambient browser token into the packaged Next.js build.
  export NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN=""
  export NEXT_TELEMETRY_DISABLED="1"
  npm run build
  npm run test:desktop-csp-runtime
)

echo "==> Preparing traced frontend runtime"
(
  cd "${ROOT_DIR}/desktop"
  npm run prepare:frontend-runtime
  npm run check:package-hygiene
)

echo "==> Installing desktop packager dependencies"
(
  cd "${ROOT_DIR}/desktop"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
)

echo "==> Packaging Vera desktop app"
(
  cd "${ROOT_DIR}/desktop"
  echo "==> Verifying Vera desktop source gates"
  npm run test:p0-source
  echo "==> Verifying SQLCipher in the Electron utility runtime"
  npm run test:sqlcipher-runtime
  echo "==> Verifying desktop package hygiene"
  npm run check:package-hygiene
  if [ "${RELEASE_SIGNING}" = "false" ]; then
    echo "==> Local-only unsigned build (do not distribute)"
    env -u CSC_NAME -u CSC_LINK -u CSC_KEY_PASSWORD \
    -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID \
    -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
    VERA_RELEASE_SIGNING=false \
    ALETHEIA_DESKTOP_BACKEND_PORT="${BACKEND_PORT}" \
    ALETHEIA_DESKTOP_FRONTEND_PORT="${FRONTEND_PORT}" \
    npm run dist:mac
  else
    echo "==> Release build; Developer ID signature and notarization are required"
    VERA_RELEASE_SIGNING=true \
    ALETHEIA_DESKTOP_BACKEND_PORT="${BACKEND_PORT}" \
    ALETHEIA_DESKTOP_FRONTEND_PORT="${FRONTEND_PORT}" \
    npm run dist:mac
  fi
)

if [ "${RELEASE_SIGNING}" = "false" ]; then
  echo "==> Local package status: signed=false notarized=false distribution=local-only"
fi

echo "==> Auditing packaged desktop resources"
(
  cd "${ROOT_DIR}/desktop"
  node scripts/desktopPackageHygieneAudit.js --app dist/mac-*/Vera.app
)

echo "==> Verifying packaged startup, migration, and interrupted restore recovery"
(
  cd "${ROOT_DIR}/desktop"
  npm run test:legacy-migration
  ALETHEIA_DESKTOP_FRONTEND_PORT=44960 \
  ALETHEIA_DESKTOP_BACKEND_PORT=44961 \
    npm run test:packaged-app
  ALETHEIA_DESKTOP_FRONTEND_PORT=45160 \
  ALETHEIA_DESKTOP_BACKEND_PORT=45161 \
    npm run test:packaged-workspace-e2e
  ALETHEIA_DESKTOP_FRONTEND_PORT=44960 \
  ALETHEIA_DESKTOP_BACKEND_PORT=44961 \
    npm run test:packaged-backup
  npm run test:packaged-restore-fail-closed
)

echo "==> Generating checksums"
(
  cd "${DIST_DIR}"
  shasum -a 256 "Vera-${DESKTOP_VERSION}-"*.dmg "Vera-${DESKTOP_VERSION}-"*.zip \
    > "Vera-${DESKTOP_VERSION}-SHA256SUMS.txt"
)

if [ "${RELEASE_SIGNING}" = "true" ]; then
  echo "==> Verifying Developer ID signature, Gatekeeper, stapled ticket, and checksums"
  (
    cd "${ROOT_DIR}/desktop"
    npm run signing:verify -- --checksum-manifest "dist/Vera-${DESKTOP_VERSION}-SHA256SUMS.txt"
  )
fi

if find "${DIST_DIR}" -maxdepth 1 -type f -name 'Aletheia-*' | grep -q .; then
  echo "Legacy Aletheia-branded artifacts remain in desktop/dist." >&2
  exit 1
fi

echo "==> Desktop artifacts"
find "${DIST_DIR}" -maxdepth 2 -type f | sort
