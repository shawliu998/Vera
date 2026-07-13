# Aletheia Desktop App

The default macOS package is an **unsigned local-development build** for use on
the Mac that built it. A Developer ID signed release remains available as an
explicit optional mode when the project has an Apple developer account.

Aletheia Desktop wraps the local backend and frontend in an Electron app. It is
for local professional workspace use and does not require Docker or a remote
database.
It is not a production SaaS service and is not legal advice software.

## macOS Signing Status

No Apple developer account is required for local development:

```bash
./scripts/package-desktop-mac.sh
```

This default mode disables certificate discovery and does not perform
application signing. Electron's bundled Mach-O executable may still report a
linker-generated ad-hoc marker; that is not a Developer ID signature and does
not make the app distributable or Gatekeeper-trusted. Keep the artifact on the
build Mac. The build does not clear quarantine attributes and the install guide
does not ask users to bypass macOS quarantine.

An actual Developer ID certificate and Apple notarization credentials are an
external release blocker today. No Vera artifact should be described as
notarized until this workflow has completed against Apple's service. When those
credentials are available, request release mode explicitly:

```bash
VERA_RELEASE_SIGNING=true \
CSC_NAME="Developer ID Application: Example Corp (TEAMID)" \
./scripts/package-desktop-mac.sh
```

Release-mode effect:

- `CSC_NAME` must be a non-ad-hoc `Developer ID Application` identity whose
  parenthesized team ID matches `APPLE_TEAM_ID`.
- Use exactly one complete notarization method: `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or `APPLE_API_KEY` (a readable
  `.p8` path), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`.
- Release preflight rejects missing, partial, mixed, ad-hoc, team-mismatched,
  or missing Keychain identity configuration when `CSC_LINK` is not used before
  the backend or frontend builds start. It reports only that signing and
  notarization are required; it never claims they succeeded or prints a
  credential value.
- Electron Builder applies hardened runtime signing and its entitlement template
  unless a project entitlement plist is added. Its `afterSign` hook submits to
  Apple, staples the accepted ticket, and validates it.
- The packaging script then verifies `codesign --verify --deep --strict`, the
  non-ad-hoc Developer ID authority and team, Gatekeeper assessment, the
  stapled ticket, and the generated SHA-256 artifact manifest.

The packaging script does not request an ad-hoc application-signing or
quarantine-bypass mode.

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

If Gatekeeper blocks a release, treat that as a failed release gate; do not ask
users to remove quarantine attributes.

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

Local output is deliberately reported as `signed=false notarized=false` and is
local-only. It does not invoke notarization, even if Apple credential variables
are present in the parent shell.

Release configuration is checked independently with:

```bash
cd desktop
VERA_RELEASE_SIGNING=true npm run signing:preflight
npm run test:signing-pipeline
```

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

- starts the bundled backend on `127.0.0.1` with local storage,
- generates a new random 32-byte private bearer token and uses
  `private_token` auth for the lifetime of that app launch,
- supplies that token only through the trusted desktop bridge to the local
  renderer; the token is not embedded in the frontend build or persisted,
- stores data under the app user-data directory with owner-only directory and
  file permissions where POSIX permissions are supported,
- starts the bundled Next.js frontend,
- opens `/aletheia/matters`,
- opens an empty real workspace by default; demo seeding is disabled in the
  packaged client,
- downloads approved litigation artifacts through the authenticated loopback
  backend, verifies the returned DOCX container, writes it atomically through a
  native Save panel, and can ask macOS to open the saved document,
- retrieves a matter original only through its authenticated `matter.read`
  route and path-free access audit, requires the backend's verified SHA-256,
  rechecks MIME, container signature, size and hash in the main process, writes
  the selected copy atomically with owner-only permissions, and warns before
  handing the original to its macOS viewer,
- renders verified PDF originals in an in-app page inspector using the bundled
  PDF.js worker with evaluation disabled and no remote resources; citation page
  numbers select only a bounded starting page, viewer teardown clears render
  tasks and bytes, and inspection never records the lawyer's separate source
  comparison decision,
- lets counsel record an explicit low-confidence OCR transcription comparison
  from that inspector only while the immutable recorded page is displayed;
  reasons and actor provenance are persisted and audited by the backend, while
  page navigation, viewing and external opening remain non-decision actions,
- monitors confirmed open tasks while the client is running, sends deduplicated
  native deadline notifications, and routes notification clicks back to the
  Work Queue,
- fetches authenticated RFC 5545 task calendars from the loopback backend,
  verifies the calendar envelope, and writes them through a native Save panel,
- creates encrypted workspace backups from Settings by stopping local services,
  taking a consistent authenticated snapshot, committing it atomically with
  owner-only permissions, and restarting services even after a failed backup,
- checks a selected backup's authentication, archive paths, required workspace
  structure, file sizes, and SHA-256 manifest without replacing current data,
- lets the operator enable high-assurance external audit anchoring from Safety
  settings through a native directory picker and confirmation; Vera provisions
  an owner-only Ed25519 key pair outside the workspace data, exposes no private
  key material to the renderer, and rolls back configuration if service restart
  fails,
- keeps local services alive when the last macOS window closes and recreates
  the window on Dock activation without rebinding the ports.

Demo fixtures are test/development data and must be enabled explicitly outside
the packaged client.

## Local Security Boundary

The backend and frontend accept connections only on loopback. The Electron
renderer is sandboxed, navigation outside the bundled local frontend is
blocked, external windows are denied, and only HTTPS or `mailto:` links may be
handed to the operating system. Desktop bridge calls reject non-local renderer
origins. Backend and frontend child processes receive an explicit environment
allowlist instead of inheriting the launching shell, so ambient cloud
credentials, proxy configuration, and Node injection flags do not cross into
the application runtime.

The local repository applies the same upload controls as the local server:
100 MB per file, 100 files per batch, an allowlist of PDF/DOCX/XLSX/TXT/MD, and
PDF/Office container signature checks. External-source access remains disabled
until an operator configures an HTTPS domain allowlist, opts in, and approves a
matter-scoped `external_source_use` checkpoint.

Audit events use a per-matter HMAC-SHA256 chain. The desktop data directory
contains the generated owner-only verification key unless an operator supplies
`ALETHEIA_AUDIT_HMAC_SECRET`. Archive is audited; permanent purge requires exact
matter-ID confirmation plus an approved `matter_purge` checkpoint and leaves a
signed deletion tombstone. Purge cannot remove copies from backups or
filesystem snapshots.

The desktop app defaults source-document and persisted-export files to
versioned AES-256-GCM envelope encryption. It provisions the independent
32-byte master key in the current user's macOS login Keychain; using Keychain
does not require an Apple Developer account. A Keychain read/provisioning
failure stops local services instead of falling back to plaintext. Existing
plaintext workspaces must be migrated using the procedure in
[application encryption](application_encryption.md).

The packaged desktop app requires SQLCipher for database metadata. It provisions
a separate 32-byte database key in the current user's macOS Keychain and starts
only after the bundled SQLCipher adapter, key, schema read, and integrity check
pass. This second Keychain item is independent of the source-file master key;
losing either key loses access to the corresponding data. Browser-only local
development may still use the plaintext metadata driver. See
[SQLCipher integration](sqlcipher_integration.md).

When the packaged client finds a legacy plaintext workspace, it runs a
fail-closed one-time migration before starting either service. The migration
verifies the plaintext database, creates and verifies a temporary owner-only
backup, converts and verifies SQLCipher row/schema parity, encrypts legacy
document/export files with the application key, and removes the temporary
plaintext backup only after the complete migration succeeds. A failed migration
leaves recovery material in the app's `migration-backups` directory and keeps
the workspace offline instead of falling back to plaintext.

The renderer resolves the backend address and per-launch bearer token at
runtime through the trusted preload bridge. Neither value is compiled into the
client bundle. The packaged Next.js dependency archive is verified, extracted
to an owner-only versioned runtime cache, and replaced atomically on update.

The optional semantic JSON index is outside SQLite and not protected by
SQLCipher. It is disabled in the desktop defaults. FileVault, encrypted backup
destinations, locked user sessions, endpoint protection, and retention policy
remain necessary host controls. Anyone controlling the unlocked OS account can
still invoke the application and Keychain as that user.

## Desktop Backup And Recovery Boundary

The Workspace settings page exposes **Create backup** and **Check backup** only
through the macOS desktop bridge. A backup contains the complete local data
directory, including the SQLCipher database, encrypted documents and exports,
indexes, and audit material. The archive is encrypted with a key derived from
the application master key using HKDF-SHA256. It is not a plaintext tar file.

After a successful preflight, Workspace settings can perform a real restore
only after explicit native confirmation. Vera stops local services, stages and
revalidates the authenticated archive on the same filesystem, preserves the
active workspace as rollback material, and switches directories atomically.
It retains an owner-only, fsynced pending transaction record outside the data
directory until restored services are healthy and the authenticated restore
journal is committed. If Vera or the machine stops after the swap, the next
launch validates the transaction and reinstates the prior workspace before any
local service starts. Unsafe or ambiguous recovery state blocks startup rather
than selecting a workspace implicitly.

Same-Mac preflight requires access to the originating application Keychain
item. Cross-Mac recovery additionally needs both separately escrowed keys: the
application master key for document/export envelopes and backup derivation,
and the independent SQLCipher database key. Never store either recovery key in
the backup file or beside it.

Audit-anchor keys and an externally selected journal are not part of the
workspace backup boundary. Preserve their public-key fingerprint and latest
head independently, and escrow the private key under a separate operator
procedure. See [independent audit anchoring](audit_anchoring.md).

## Release Validation

Minimum validation for a local unsigned build:

```bash
./scripts/package-desktop-mac.sh
APP_PATH="desktop/dist/mac-$(node -p 'process.arch')/Vera.app"
open "$APP_PATH"
curl http://127.0.0.1:43761/health
open http://127.0.0.1:43760/aletheia/matters
cd desktop && npm run test:packaged-app
cd desktop && npm run test:packaged-backup
cd desktop && npm run test:legacy-migration
```

The expected status without Developer ID is not application-signed and not
trusted for distribution:

```bash
APP_PATH="desktop/dist/mac-$(node -p 'process.arch')/Vera.app"
spctl --assess --type execute --verbose "$APP_PATH"
```

Gatekeeper assessment and `codesign --verify --deep --strict` are expected to
fail for local mode. Do not change quarantine attributes to make the check pass.
Do not describe an artifact as Developer ID signed, notarized, or Gatekeeper-
clean until the explicit release workflow has produced and verified it.

For a credentialed release, the package command runs verification automatically.
It can also be rerun with the checksum manifest after packaging:

```bash
cd desktop
VERA_EXPECTED_TEAM_ID=TEAMID \
npm run signing:verify -- --checksum-manifest dist/Vera-<version>-SHA256SUMS.txt
```
