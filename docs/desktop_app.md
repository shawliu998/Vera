# Aletheia Desktop App

Current desktop distribution: **official ad-hoc signed macOS local release**.

Aletheia Desktop wraps the local backend and frontend in an Electron app. It is
for local professional workspace use and does not require Docker or Supabase.
It is not a production SaaS service and is not legal advice software.

## macOS Signing Status

This release is **ad-hoc signed but not Developer ID signed and not notarized**
because the project does not yet have an Apple Developer ID certificate.

Practical effect:

- The `.dmg` and `.zip` are official Aletheia release assets.
- The app bundle has a valid local ad-hoc code signature so its nested Electron
  code structure can be verified.
- macOS Gatekeeper may show "Apple could not verify" or "unidentified
  developer" warnings.
- Users must explicitly approve the first launch.
- This is expected for an unsigned build and is separate from whether the app
  bundle itself is structurally valid.

When an Apple Developer ID is available, the follow-up release should enable
Developer ID signing, hardened runtime, and notarization.

## Install From Release

Download from the GitHub Release page:

- `Aletheia-1.0.1-arm64.dmg`
- or `Aletheia-1.0.1-arm64.zip`
- `Aletheia-1.0.1-SHA256SUMS.txt`

Verify the download:

```bash
cd ~/Downloads
shasum -a 256 -c Aletheia-1.0.1-SHA256SUMS.txt
```

Open the app:

1. Open the `.dmg` and drag Aletheia to Applications.
2. In Finder, right-click Aletheia and choose **Open**.
3. Confirm the macOS warning.

If macOS still blocks the app after you have verified the checksum:

```bash
xattr -dr com.apple.quarantine /Applications/Aletheia.app
open /Applications/Aletheia.app
```

## Package macOS App

From the repository root:

```bash
./scripts/package-desktop-mac.sh
```

The script:

1. builds the backend TypeScript server,
2. builds the Next.js frontend for desktop-local API port `43761`,
3. installs Electron packager dependencies under `desktop/`,
4. packages the app with the rounded Aletheia desktop icon generated from the
   same ring mark used by the web UI,
5. creates macOS artifacts under `desktop/dist/`,
6. writes `Aletheia-<version>-SHA256SUMS.txt`.

Regenerate icon assets after changing the source mark:

```bash
./scripts/generate-icons.sh
```

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
- opens `/aletheia/matters`,
- seeds the local-only **Private Contract Review Demo** matter on the first
  empty workspace.

Set `ALETHEIA_DEMO_SEED_ENABLED=false` before launching if you need a blank
workspace.

## Release Validation

Minimum validation before publishing unsigned desktop assets:

```bash
./scripts/package-desktop-mac.sh
open desktop/dist/mac-arm64/Aletheia.app
curl http://127.0.0.1:43761/health
open http://127.0.0.1:43760/aletheia/matters
```

The expected signing status without Developer ID:

```bash
spctl --assess --type execute --verbose desktop/dist/mac-arm64/Aletheia.app
```

`codesign --verify --deep --strict` should pass for the app bundle. Gatekeeper
assessment is still expected to fail because the signature is ad-hoc rather than
Developer ID trusted. Do not describe the release as Developer ID signed,
notarized, or Gatekeeper-clean until a Developer ID signed and notarized
artifact has been produced.
