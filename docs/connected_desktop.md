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
5. local-only `.app`, DMG, and ZIP packaging, or credentialed Developer ID signing and notarization;
6. packaged `.app` smoke against an isolated loopback fixture.

Artifacts are written under `desktop/dist/` as `Vera-Connected-<version>-<arch>.*`. Local artifacts are unsigned and unnotarized; distribution requires a separate Developer ID signing and notarization release pipeline.

## macOS distribution modes

### Local testing without an Apple Developer account

The default command remains intentionally local-only:

```bash
./scripts/package-desktop-mac.sh
```

It clears any ambient signing/notarization variables before packaging, reports
`signed=false notarized=false distribution=local-only`, validates the connected
desktop security boundary, smoke-tests the packaged application, verifies the
DMG/ZIP structure, and writes SHA-256 checksums. It does not contact Apple's
notary service and must not be described as a public release.

For a locally built copy, install the DMG in the usual way. On first launch,
Control-click `Vera.app`, choose **Open**, then confirm **Open**. Do not disable
Gatekeeper globally. Share this local-only build only with testers who
understand that macOS cannot verify its publisher.

A free Apple account or Xcode Personal Team does not provide the Developer ID
Application certificate required for direct distribution. Vera cannot create,
emulate, borrow, or self-sign an Apple-trusted Developer ID.

### Developer ID release after program enrollment

The release path is already wired but fails closed until a real certificate and
one complete notarization credential method are available:

```bash
VERA_RELEASE_SIGNING=true \
CSC_NAME="Legal Name (TEAMID1234)" \
APPLE_ID="developer@example.com" \
APPLE_APP_SPECIFIC_PASSWORD="<app-specific-password>" \
APPLE_TEAM_ID="TEAMID1234" \
./scripts/package-desktop-mac.sh
```

`CSC_NAME` is the exact qualifier shown after `Developer ID Application:` in
Keychain Access. The script also supports an App Store Connect API key through
`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and
`APPLE_TEAM_ID`. Never commit certificate files, passwords, or API keys.

The release build performs these hard gates in order:

1. exact Developer ID identity and Team ID preflight;
2. hardened-runtime signing using the reviewed minimum entitlements;
3. app notarization, ticket stapling, and validation;
4. signed DMG notarization, ticket stapling, and validation;
5. strict nested-code verification, Gatekeeper assessment, ZIP extraction
   verification, and checksum verification.

Any missing identity, partial credential set, team mismatch, ad-hoc identity,
notarization failure, or Gatekeeper failure stops the build. Only the final
success message may report `signed=true notarized=true`.

Current machine readiness can be inspected without signing or contacting Apple:

```bash
npm run signing:readiness --prefix desktop -- --no-artifacts
```

Apple's current distribution requirements are documented at
<https://developer.apple.com/support/developer-id/> and
<https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>.

## Current acceptance

- Source security audit: passed.
- Development Electron startup smoke: passed.
- Packaged Electron startup smoke: passed.
- Real macOS window: passed at 1380 × 920.
- Existing Supabase login session survived application restart.
- Assistant navigation, Ask/Work switching, keyboard focus, API-key settings, Matter history, and responsive Vera UI rendered in the packaged client.
