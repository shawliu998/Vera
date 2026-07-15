#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${ALETHEIA_DESKTOP_BACKEND_PORT:-43761}"
FRONTEND_PORT="${ALETHEIA_DESKTOP_FRONTEND_PORT:-43760}"
API_BASE="http://127.0.0.1:${BACKEND_PORT}"
DESKTOP_VERSION="$(node -p "require('${ROOT_DIR}/desktop/package.json').version")"
RELEASE_SIGNING="${VERA_RELEASE_SIGNING:-false}"
DIST_DIR="${ROOT_DIR}/desktop/dist"
STAGING_DIST_DIR=""
PUBLISH_ROLLBACK_ROOT=""
PUBLISH_STARTED="false"
DIST_PUBLISHED="false"

cleanup() {
  local exit_code=$?
  local preserve_rollback="false"
  trap - EXIT INT TERM HUP

  if [ "${DIST_PUBLISHED}" != "true" ] &&
    [ -n "${PUBLISH_ROLLBACK_ROOT}" ] &&
    { [ -e "${PUBLISH_ROLLBACK_ROOT}/dist" ] || [ -L "${PUBLISH_ROLLBACK_ROOT}/dist" ]; }; then
    if ! rm -rf "${DIST_DIR}" ||
      ! mv "${PUBLISH_ROLLBACK_ROOT}/dist" "${DIST_DIR}"; then
      preserve_rollback="true"
      echo "Could not restore the previous desktop artifacts; they remain at ${PUBLISH_ROLLBACK_ROOT}/dist." >&2
    fi
  elif [ "${PUBLISH_STARTED}" = "true" ] && [ "${DIST_PUBLISHED}" != "true" ]; then
    rm -rf "${DIST_DIR}" || true
  fi

  if [ -n "${STAGING_DIST_DIR}" ]; then
    rm -rf "${STAGING_DIST_DIR}" || true
  fi
  if [ -n "${PUBLISH_ROLLBACK_ROOT}" ] && [ "${preserve_rollback}" != "true" ]; then
    rm -rf "${PUBLISH_ROLLBACK_ROOT}" || true
  fi
  exit "${exit_code}"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

if [ "${RELEASE_SIGNING}" != "false" ] && [ "${RELEASE_SIGNING}" != "true" ]; then
  echo "VERA_RELEASE_SIGNING must be exactly true or false." >&2
  exit 1
fi

if [ -n "${ALETHEIA_MAC_BUILD_MODE:-}" ]; then
  echo "ALETHEIA_MAC_BUILD_MODE is no longer used; use VERA_RELEASE_SIGNING=true for a release build." >&2
  exit 1
fi

STAGING_DIST_DIR="$(mktemp -d "${ROOT_DIR}/desktop/.dist-staging.XXXXXX")"
PUBLISH_ROLLBACK_ROOT="$(mktemp -d "${ROOT_DIR}/desktop/.dist-rollback.XXXXXX")"

echo "==> Checking macOS signing mode"
(
  cd "${ROOT_DIR}/desktop"
  VERA_RELEASE_SIGNING="${RELEASE_SIGNING}" npm run signing:preflight
  VERA_RELEASE_SIGNING="${RELEASE_SIGNING}" npm run signing:readiness -- --no-artifacts
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
  echo "==> Verifying offline macOS signing/notarization contracts"
  npm run test:signing-pipeline
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
    npm run dist:mac -- --config.directories.output="${STAGING_DIST_DIR}"
  else
    echo "==> Release build; Developer ID signature and notarization are required"
    VERA_RELEASE_SIGNING=true \
    ALETHEIA_DESKTOP_BACKEND_PORT="${BACKEND_PORT}" \
    ALETHEIA_DESKTOP_FRONTEND_PORT="${FRONTEND_PORT}" \
    npm run dist:mac -- --config.directories.output="${STAGING_DIST_DIR}"
  fi
)

shopt -s nullglob
PACKAGED_APP_PATHS=("${STAGING_DIST_DIR}"/mac*/Vera.app)
DMG_PATHS=("${STAGING_DIST_DIR}"/"Vera-${DESKTOP_VERSION}-"*.dmg)
ZIP_PATHS=("${STAGING_DIST_DIR}"/"Vera-${DESKTOP_VERSION}-"*.zip)
shopt -u nullglob

if [ "${#PACKAGED_APP_PATHS[@]}" -ne 1 ] || [ ! -d "${PACKAGED_APP_PATHS[0]:-}" ]; then
  echo "Packaging must produce exactly one Vera.app under a mac* directory." >&2
  exit 1
fi
if [ "${#DMG_PATHS[@]}" -ne 1 ] || [ ! -f "${DMG_PATHS[0]:-}" ]; then
  echo "Packaging must produce exactly one Vera DMG for version ${DESKTOP_VERSION}." >&2
  exit 1
fi
if [ "${#ZIP_PATHS[@]}" -ne 1 ] || [ ! -f "${ZIP_PATHS[0]:-}" ]; then
  echo "Packaging must produce exactly one Vera ZIP for version ${DESKTOP_VERSION}." >&2
  exit 1
fi

PACKAGED_APP_PATH="${PACKAGED_APP_PATHS[0]}"
CHECKSUM_MANIFEST="${STAGING_DIST_DIR}/Vera-${DESKTOP_VERSION}-SHA256SUMS.txt"

if [ "${RELEASE_SIGNING}" = "false" ]; then
  echo "==> Local package status: signed=false notarized=false distribution=local-only"
fi

echo "==> Auditing packaged desktop resources"
(
  cd "${ROOT_DIR}/desktop"
  node scripts/desktopPackageHygieneAudit.js --app "${PACKAGED_APP_PATH}"
)

echo "==> Verifying packaged startup, migration, and interrupted restore recovery"
(
  cd "${ROOT_DIR}/desktop"
  npm run test:legacy-migration
  ALETHEIA_PACKAGED_APP_PATH="${PACKAGED_APP_PATH}" \
  ALETHEIA_DESKTOP_FRONTEND_PORT=44960 \
  ALETHEIA_DESKTOP_BACKEND_PORT=44961 \
    npm run test:packaged-app
  ALETHEIA_PACKAGED_APP_PATH="${PACKAGED_APP_PATH}" \
  ALETHEIA_DESKTOP_FRONTEND_PORT=45160 \
  ALETHEIA_DESKTOP_BACKEND_PORT=45161 \
    npm run test:packaged-workspace-e2e
  ALETHEIA_PACKAGED_APP_PATH="${PACKAGED_APP_PATH}" \
  ALETHEIA_DESKTOP_FRONTEND_PORT=44960 \
  ALETHEIA_DESKTOP_BACKEND_PORT=44961 \
    npm run test:packaged-backup
  ALETHEIA_PACKAGED_APP_PATH="${PACKAGED_APP_PATH}" \
    npm run test:packaged-restore-fail-closed
  ALETHEIA_PACKAGED_APP_PATH="${PACKAGED_APP_PATH}" \
  ALETHEIA_DESKTOP_FRONTEND_PORT=45360 \
  ALETHEIA_DESKTOP_BACKEND_PORT=45361 \
    npm run test:packaged-native-ocr
)

echo "==> Generating checksums"
(
  cd "${STAGING_DIST_DIR}"
  shasum -a 256 "Vera-${DESKTOP_VERSION}-"*.dmg "Vera-${DESKTOP_VERSION}-"*.zip \
    > "${CHECKSUM_MANIFEST}"
)

ARTIFACT_ARGUMENTS=(
  --app "${PACKAGED_APP_PATH}"
  --dmg "${DMG_PATHS[0]}"
  --zip "${ZIP_PATHS[0]}"
  --checksum-manifest "${CHECKSUM_MANIFEST}"
)

if [ "${RELEASE_SIGNING}" = "true" ]; then
  echo "==> Verifying Developer ID signature, Gatekeeper, stapled ticket, and checksums"
  (
    cd "${ROOT_DIR}/desktop"
    npm run signing:verify -- "${ARTIFACT_ARGUMENTS[@]}"
  )
else
  echo "==> Reporting unsigned/unnotarized artifact readiness"
  (
    cd "${ROOT_DIR}/desktop"
    VERA_RELEASE_SIGNING=false npm run signing:readiness -- "${ARTIFACT_ARGUMENTS[@]}"
  )
fi

if find "${STAGING_DIST_DIR}" -maxdepth 1 -type f -name 'Aletheia-*' | grep -q .; then
  echo "Legacy Aletheia-branded artifacts remain in the staged package." >&2
  exit 1
fi

echo "==> Publishing verified desktop artifacts"
if [ -e "${DIST_DIR}" ] || [ -L "${DIST_DIR}" ]; then
  mv "${DIST_DIR}" "${PUBLISH_ROLLBACK_ROOT}/dist"
fi
PUBLISH_STARTED="true"
mv "${STAGING_DIST_DIR}" "${DIST_DIR}"
STAGING_DIST_DIR=""
DIST_PUBLISHED="true"
rm -rf "${PUBLISH_ROLLBACK_ROOT}"
PUBLISH_ROLLBACK_ROOT=""

echo "==> Desktop artifacts"
find "${DIST_DIR}" -maxdepth 2 -type f | sort
