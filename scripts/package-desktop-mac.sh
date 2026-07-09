#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${ALETHEIA_DESKTOP_BACKEND_PORT:-43761}"
FRONTEND_PORT="${ALETHEIA_DESKTOP_FRONTEND_PORT:-43760}"
API_BASE="http://127.0.0.1:${BACKEND_PORT}"

echo "==> Building backend"
(
  cd "${ROOT_DIR}/backend"
  npm run build
)

echo "==> Building frontend for desktop API ${API_BASE}"
(
  cd "${ROOT_DIR}/frontend"
  NEXT_PUBLIC_API_BASE_URL="${API_BASE}" \
  NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}" \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY="${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY:-demo-anon-key}" \
  NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN="${NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN:-}" \
  npm run build
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

echo "==> Packaging Aletheia desktop app"
(
  cd "${ROOT_DIR}/desktop"
  ALETHEIA_DESKTOP_BACKEND_PORT="${BACKEND_PORT}" \
  ALETHEIA_DESKTOP_FRONTEND_PORT="${FRONTEND_PORT}" \
  npm run dist:mac
)

echo "==> Desktop artifacts"
find "${ROOT_DIR}/desktop/dist" -maxdepth 2 -type f | sort
