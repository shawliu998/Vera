# Aletheia Desktop App

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.**

The desktop package wraps the local Aletheia backend and frontend in an Electron
app. It does not require Docker or Supabase.

## Package macOS App

From the repository root:

```bash
./scripts/package-desktop-mac.sh
```

The script:

1. builds the backend TypeScript server,
2. builds the Next.js frontend for desktop-local API port `43761`,
3. installs Electron packager dependencies under `desktop/`,
4. creates macOS artifacts under `desktop/dist/`.

Default desktop ports:

```text
frontend: http://127.0.0.1:43760
backend:  http://127.0.0.1:43761
```

Override them before packaging and launching only when needed:

```bash
ALETHEIA_DESKTOP_FRONTEND_PORT=44760 \
ALETHEIA_DESKTOP_BACKEND_PORT=44761 \
./scripts/package-desktop-mac.sh
```

## Runtime Behavior

On launch, the app:

- starts the bundled backend with local storage,
- stores data under the app user-data directory,
- starts the bundled Next.js frontend,
- opens `/aletheia`,
- seeds the local-only **Private Contract Review Demo** matter on the first
  empty workspace.

Set `ALETHEIA_DEMO_SEED_ENABLED=false` before launching if you need a blank
workspace.

## Scope

This package is an unsigned local/private-pilot desktop build. It is intended
for local reviewer evaluation and is not notarized, signed, or positioned as a
production SaaS installer.
