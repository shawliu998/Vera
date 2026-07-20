# Vera connected desktop

Vera Desktop 1.1 is a connected macOS client for the `1d72e005` Mike/Vera baseline. Electron provides the trusted desktop window; the existing Vera web application continues to own authentication, Matter data, documents, Agent Tasks, citations, model settings, and exports.

## Runtime contract

Set `VERA_APP_URL` to the public HTTPS address of the deployed Vera web application:

```bash
VERA_APP_URL=https://vera.example.com /Applications/Vera.app/Contents/MacOS/Vera
```

For local development only, loopback HTTP is accepted:

```bash
VERA_APP_URL=http://localhost:3002/assistant \
  ./desktop/dist/mac-arm64/Vera.app/Contents/MacOS/Vera
```

Packaged builds deliberately have no default production URL. They show a bounded connection-required screen until the deployment supplies `VERA_APP_URL`. The URL must not contain credentials.

## Security boundary

- Renderer sandboxing, context isolation, web security, and disabled Node integration are mandatory.
- Navigation remains inside the exact configured Vera origin.
- HTTPS and `mailto:` links outside that origin open in the system browser; other schemes are rejected.
- Camera, microphone, geolocation, payment, USB, serial, and other ambient permissions are denied.
- WebViews and drag-to-navigate are disabled.
- The preload exposes only `{ connected, platform, version }`; it exposes no token, filesystem, shell, or network primitive.
- Downloads use a native Save dialog and remain user initiated.
- Supabase sessions remain in Electron's Chromium profile. The desktop package does not contain service-role keys, model keys, API tokens, Matter files, or backend secrets.

This connected client does not claim offline operation, SQLCipher storage, or a bundled local Express/Supabase runtime. Those belonged to the superseded local-first host and are not silently simulated.

## Build and verification

```bash
./scripts/package-desktop-mac.sh
```

The script runs:

1. backend TypeScript build;
2. frontend TypeScript, Agent Task lint, and production build;
3. connected desktop security audit;
4. development Electron smoke;
5. unsigned local `.app`, DMG, and ZIP packaging;
6. packaged `.app` smoke against an isolated loopback fixture.

Artifacts are written under `desktop/dist/` as `Vera-Connected-<version>-<arch>.*`. Local artifacts are unsigned and unnotarized; distribution requires a separate Developer ID signing and notarization release pipeline.

## Current acceptance

- Source security audit: passed.
- Development Electron startup smoke: passed.
- Packaged Electron startup smoke: passed.
- Real macOS window: passed at 1380 × 920.
- Existing Supabase login session survived application restart.
- Assistant navigation, Ask/Work switching, keyboard focus, API-key settings, Matter history, and responsive Vera UI rendered in the packaged client.
