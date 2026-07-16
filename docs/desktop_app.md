# Vera Desktop App

This document starts with the current Mike-derived Vera P0 client. The legacy
desktop operations reference is retained below for historical compatibility.

## Current release status

Status on 2026-07-15: **P0 Phases 0-7 complete; fresh packaged verification
passed**. One full invocation of `./scripts/package-desktop-mac.sh` exited `0`.
It built the current backend, frontend, Electron host and credential worker,
then passed package hygiene, SQLCipher, legacy migration, packaged startup and
port release, workspace cross-restart E2E, backup bridge, and interrupted
restore fail-closed verification.

The packaged smoke launched the actual app with
`ALETHEIA_APPLICATION_ENCRYPTION=disabled` and separately with
`ALETHEIA_DATABASE_ENCRYPTION=metadata_plaintext`. Both downgrade attempts were
rejected with exit code `1` before the local ports were occupied. The packaged
restore fail-closed suite also inspected the working desktop log: it contained
`startup_failed`, contained no `renderer_window_creating` event, kept the local
services offline, and retained the pending restore record for recovery.

The default package mode is unsigned and unnotarized. It is a local development
artifact for the Mac that built it, not a distributable release. A release
claim requires a successful `VERA_RELEASE_SIGNING=true` build with a real
Developer ID identity, Apple notarization, stapling, Gatekeeper verification,
and checksum verification.

## Product and routes

Electron opens the real Vera workspace at `/assistant`. Its four core
Mike-derived workspaces are Assistant (`/assistant`), Projects (`/projects`),
Tabular Review (`/tabular-review`), and Workflows (`/workflows`); Settings
(`/settings`) is the fifth first-level local control surface. Project pages make
Documents, Assistant, Workflows, and Tabular Reviews available within the same
generic Project container.

The UI and product framework are ported from Open Legal Products' Mike at the
pinned commit `e32daad5a4c64a5561e04c53ee12411e3c5e7238`, with permission to use
the Mike UI. Mike and Vera retain `AGPL-3.0-only` attribution. Vera's deliberate
local adaptations replace cloud authentication, organisations, sharing,
Supabase/PostgreSQL, R2/S3, MCP/OAuth, and server-wide provider secrets with a
single-user desktop runtime.

Legacy `/aletheia/*` routes remain compiled for regression and access to
existing local records. They are not part of the new primary navigation.

## Build and artifacts

On macOS, install the backend and frontend dependencies, then run the packaging
script from the repository root:

```bash
npm ci --prefix backend
npm ci --prefix frontend
./scripts/package-desktop-mac.sh
```

The default outputs are:

```text
desktop/dist/mac-<arch>/Vera.app
desktop/dist/Vera-1.0.1-<arch>.dmg
desktop/dist/Vera-1.0.1-<arch>.zip
desktop/dist/Vera-1.0.1-SHA256SUMS.txt
```

The version is read from `desktop/package.json`; do not hard-code `1.0.1` in
release automation. The default script explicitly reports
`signed=false notarized=false distribution=local-only`.

### Accepted 2026-07-15 arm64 artifact record

```text
app:      desktop/dist/mac-arm64/Vera.app

DMG:      desktop/dist/Vera-1.0.1-arm64.dmg
bytes:    198122845
SHA-256:  fd246214916b3485e25bb16c8e00bcf6e8be471ed95679190e7685a5c1c49ef8

ZIP:      desktop/dist/Vera-1.0.1-arm64.zip
bytes:    200992113
SHA-256:  7be4a9504151ddd8518141901e3d2753a1cda2fbe13ac27fa7842a9f3d347f1b

manifest: desktop/dist/Vera-1.0.1-SHA256SUMS.txt
```

Running `shasum -a 256 -c Vera-1.0.1-SHA256SUMS.txt` from `desktop/dist`
verified both entries. The manifest content is:

```text
fd246214916b3485e25bb16c8e00bcf6e8be471ed95679190e7685a5c1c49ef8  Vera-1.0.1-arm64.dmg
7be4a9504151ddd8518141901e3d2753a1cda2fbe13ac27fa7842a9f3d347f1b  Vera-1.0.1-arm64.zip
```

To request the credentialed release path:

```bash
VERA_RELEASE_SIGNING=true \
CSC_NAME="Example Corp (ABCDE12345)" \
APPLE_TEAM_ID="ABCDE12345" \
APPLE_ID="release@example.com" \
APPLE_APP_SPECIFIC_PASSWORD="..." \
./scripts/package-desktop-mac.sh
```

The API-key notarization variant is also supported by the signing scripts. Do
not combine partial or mixed notarization methods.

## Local runtime boundary

Vera owns all required local services. It does not require Docker, Supabase,
PostgreSQL, R2/S3, or a separately started backend.

At launch, Electron:

1. takes a single-instance lock and preserves the existing
   `Application Support/aletheia-desktop` compatibility directory;
2. provisions or reads the independent application-encryption and SQLCipher
   keys from the current user's macOS Keychain;
3. creates an isolated credential-worker utility process for model-provider
   secrets;
4. creates a new random 32-byte bearer token for that launch;
5. starts the backend on `127.0.0.1:43761` and the frontend on
   `127.0.0.1:43760` using explicit environment allowlists;
6. passes the token only through the trusted preload bridge and opens
   `/assistant` after both services are healthy;
7. shuts down the frontend, backend, and credential worker in a bounded order
   and verifies port release.

The renderer uses `nodeIntegration: false`, `contextIsolation: true`, and
`sandbox: true`. New windows and untrusted navigation are denied, renderer
permissions are denied by default, and the desktop CSP limits connections to
the exact loopback backend. Child processes do not inherit ambient cloud
credentials, proxy variables, or Node injection flags.

## Local persistence and credentials

Workspace schema migrations currently run through v16
(`v16MatterClassification`). V11 adds the Project source foundation, v12 adds
Document Studio, v13 adds source-retention lifecycle enforcement, v14 adds
reviewable Document Studio suggestions, and v15 adds the optional one-to-one
Matter Profile plus fail-closed Matter Policy foundation. V16 adds explicit
workspace classification and bounded jurisdiction while leaving existing v15
rows unclassified instead of guessing a mapping. Projects, folders, document
versions, chats, messages, jobs, workflow definitions/runs/step runs, Tabular
Reviews/cells, model-profile metadata, durable Assistant events, source
provenance, and Studio state use the local Workspace database. The packaged
client requires SQLCipher and fails closed if the database key, adapter, schema
read, or integrity check fails.

Original files, extracted content, and local exports use versioned
AES-256-GCM envelope encryption. The application master key and SQLCipher key
are separate Keychain items. Losing either key can make its corresponding data
unrecoverable; use the documented escrow procedure for cross-Mac recovery.

Provider API keys are never stored in normal Workspace tables, returned by the
Settings API, or sent to the renderer after entry. The renderer submits a new
secret once; the backend sends it over a private MessagePort to the isolated
credential worker, which writes the bound item to the macOS Keychain. Database
records contain only a non-secret credential reference, origin binding, and
status. Credential readback is available only to the backend model adapter.

## Models and Settings

Settings exposes OpenAI, DeepSeek, Anthropic, Gemini, and OpenAI-compatible
profiles. Each profile stores its model name, endpoint metadata, context/output
limits, enabled/default state, connection-test revision, and non-secret
capabilities locally. A credential and a current successful connection test are
required before a profile becomes ready and can be selected as default.

OpenAI-compatible endpoints use a hardened transport. Public custom endpoints
must use HTTPS. Exact-loopback HTTP is disabled by default and can be enabled
only with `ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP=true` for explicit local
development or the packaged mock-provider E2E.

The Local Data Settings page can:

- open the data or logs directory through controlled native actions;
- create an authenticated encrypted workspace backup;
- inspect a selected backup before restore;
- perform a confirmed, fail-closed restore with rollback/recovery state;
- restart the owned local services;
- export a redacted diagnostic summary.

Backups include the encrypted database and workspace files, but not
model-provider credentials or either Keychain encryption key. A restore cannot
make missing Keychain material portable.

Desktop logs and model-call diagnostics are owner-only, bounded, rotated, and
redacted. Model-call records contain request ID, provider, model, start/end
times, token counts when supplied, terminal status, and safe error code; they do
not contain prompts, document text, authorization headers, API keys, or local
file paths. The exported diagnostic bundle contains runtime/security and
directory summaries, not log contents or user content.

## Required verification

Run source gates before packaging:

```bash
npm run build --prefix backend
npm run test:workspace:migrations --prefix backend
npm run test:workspace:model-settings-runtime --prefix backend
npm run test:workspace:model-call-diagnostics --prefix backend
npm run test:workspace:assistant-execution --prefix backend
npm run test:workspace:workflow-execution --prefix backend
npm run test:workspace:tabular-execution --prefix backend

npm run lint --prefix frontend
npm run build --prefix frontend
npm run test:i18n --prefix frontend
npm run test:assistant --prefix frontend
npm run test:workflows --prefix frontend
npm run test:tabular --prefix frontend

npm run test:product-rename --prefix desktop
npm run test:keychain-provisioning --prefix desktop
npm run test:keychain-credential-store --prefix desktop
npm run test:credential-worker --prefix desktop
npm run test:credential-bridge --prefix desktop
npm run test:runtime-security --prefix desktop
npm run test:diagnostic-bundle --prefix desktop
npm run test:desktop-logger --prefix desktop
git diff --check
```

`./scripts/package-desktop-mac.sh` then builds a fresh package and runs the
packaged SQLCipher/hygiene checks, legacy migration, startup/port-release smoke,
workspace restart E2E, backup bridge, and interrupted-restore fail-closed audit.
The workspace E2E uses an isolated exact-loopback mock provider only for the
test. It creates a Project, parses two TXT files, persists an Assistant answer
with two citations, executes a two-step Workflow, completes and exports a
two-document by two-column Tabular Review, closes Vera, reopens the same
encrypted workspace, and verifies the objects and results again.

The completed P0 result is:

```text
Phase 7: complete; fresh packaged verification passed
signed: false
notarized: false
distribution: local-only
```

## Archived pre-Vera desktop operations reference — not current instructions

The material below predates the Mike-derived P0 product. It is retained because
the underlying litigation, audit, migration, encryption, and recovery paths
remain compatibility-sensitive. Historical Aletheia artifact names, default
routes, and UI instructions below are not current release instructions.
Identifiers containing `aletheia` in commands, environment variables, routes,
database tables, or storage paths are retained compatibility interfaces; they
are not Vera product or user-interface branding.

The default macOS package is an **unsigned local-development build** for use on
the Mac that built it. A Developer ID signed release remains available as an
explicit optional mode when the project has an Apple developer account.

Vera Desktop wraps the local backend and frontend in an Electron app. It is for
local professional workspace use and does not require Docker or a remote
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
CSC_NAME="Example Corp (ABCDE12345)" \
APPLE_TEAM_ID="ABCDE12345" \
APPLE_ID="release@example.com" \
APPLE_APP_SPECIFIC_PASSWORD="..." \
./scripts/package-desktop-mac.sh
```

Release-mode effect:

- `CSC_NAME` must be the exact Electron Builder-compatible qualifier
  `Certificate Name (TEAMID)`, without the `Developer ID Application:` prefix.
  Vera reconstructs and checks the complete
  `Developer ID Application: Certificate Name (TEAMID)` authority before any
  Apple submission; the parenthesized team ID must match `APPLE_TEAM_ID`.
- Use exactly one complete notarization method: `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or `APPLE_API_KEY` (a readable
  `.p8` path), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`.
- Release preflight rejects missing, partial, mixed, ad-hoc, team-mismatched,
  or missing Keychain identity configuration when `CSC_LINK` is not used before
  the backend or frontend builds start. It reports only that signing and
  notarization are required; it never claims they succeeded or prints a
  credential value.
- Electron Builder applies hardened runtime signing with Vera's checked-in,
  least-privilege main and inherited entitlement plists. The main app receives
  JIT only; nested Electron runtime code additionally receives its executable-
  memory requirement. The verifier requires those exact allowlists for every
  main and nested code target; extra or missing entitlements fail the release
  gate.
- The packaging script verifies nested code inner-to-outer, then the outer app,
  Developer ID authority/team, hardened-runtime flags, Gatekeeper, stapled
  tickets, final DMG/ZIP semantics, and the generated SHA-256 manifest. It
  mounts the DMG read-only with browsing and automatic opening disabled,
  requires exactly one top-level `Vera.app`, applies the same full verification,
  and detaches in `finally` with a force fallback. ZIP is not itself codesignable
  or staplable. Before extraction, Vera rejects duplicate/unsafe paths,
  unsupported entry types, and absolute or archive-escaping symbolic-link
  targets. The archive must contain exactly one application, named `Vera.app`,
  and that extracted app receives the full verification; ZIP container checks
  are reported as not applicable, not passed.
- Electron Builder's implicit notarization is pinned off, so credentials cannot
  cause an unreviewed duplicate submission. `afterSign` first checks the exact
  Developer ID authority/team, then notarizes and staples the signed app.
  Electron Builder signs the final DMG only in credentialed release mode, and
  the release-only
  `afterAllArtifactBuild` hook checks its Developer ID/team before submission,
  then notarizes, staples, and validates that DMG. Both notarization hooks
  explicitly skip local unsigned builds.

The packaging script does not request an ad-hoc application-signing or
quarantine-bypass mode.

## Credentialed Vera release installation contract

No credentialed public release is claimed by this document. When a release has
passed the Developer ID, notarization, stapling, Gatekeeper, and checksum gates,
publish these Vera assets together:

- `Vera-<version>-<arch>.dmg`
- or `Vera-<version>-<arch>.zip`
- `Vera-<version>-SHA256SUMS.txt`

Verify the download:

```bash
cd ~/Downloads
shasum -a 256 -c Vera-<version>-SHA256SUMS.txt
```

Open the app:

1. Open the `.dmg` and drag Vera to Applications.
2. Open Vera normally from Applications.

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
4. packages the app with the rounded Vera desktop icon generated from the
   same ring mark used by the web UI,
5. creates macOS artifacts under `desktop/dist/`,
6. writes `Vera-<version>-SHA256SUMS.txt`.

Local output is deliberately reported as `signed=false notarized=false` and is
local-only. It does not invoke notarization, even if Apple credential variables
are present in the parent shell.

Release configuration is checked independently with:

```bash
cd desktop
VERA_RELEASE_SIGNING=true npm run signing:preflight
npm run signing:readiness -- --no-artifacts
npm run test:signing-pipeline
```

`signing:readiness` is read-only and defaults to exit 0. With no release
credentials or with local artifacts it explicitly reports `UNSIGNED` and
`NOT_NOTARIZED` plus blockers without printing any environment value. After a
credentialed build, rerun it with `--strict-release`; strict mode requires the
app, DMG, ZIP, Developer ID/team, hardened runtime, Gatekeeper results, tickets,
checksums, and every command-line tool used by those checks to be complete. It
never invokes signing or `notarytool submit`.

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
- opens the Vera workspace at `/assistant`; legacy `/aletheia/*` routes remain
  available only for compatibility regression and existing local records,
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
open http://127.0.0.1:43760/assistant
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
CSC_NAME="Example Corp (ABCDE12345)" \
VERA_EXPECTED_TEAM_ID=ABCDE12345 \
npm run signing:verify -- --checksum-manifest dist/Vera-<version>-SHA256SUMS.txt
```
