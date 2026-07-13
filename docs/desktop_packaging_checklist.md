# Desktop Packaging Checklist

This checklist is for a private local Aletheia desktop/workstation build. It is
not a release process yet; it defines what must be true before packaging.

## Required Local Capabilities

- `npm run check:aletheia:preflight` passes before private handoff or local
  package generation. It runs backend build, local-first audits, local
  regression, restore drill, retrieval eval, package preflight, completion
  audit, and frontend lint/build in deployment order.
- `npm run check:aletheia:doctor` passes in the target local/private
  environment.
- `npm run check:aletheia:backup` produces the backup scope manifest.
- `npm run check:aletheia:restore` validates the restore source without
  copying, overwriting, or deleting local data.
- `npm run check:aletheia:privacy` fails on tracked local data, disallowed
  `.env` files, private key blocks, high-confidence API key shapes, or
  non-placeholder private deployment secrets.
- `npm run check:aletheia:ops-readiness` verifies the local doctor, local
  launcher, `/health`, private-token auth boundary, package metadata,
  backup/restore/audit integrity chain, and private deployment runbook.
- `npm run check:aletheia:source-provenance` verifies source chunk IDs,
  document IDs, quote offsets, support status, SQLite FTS5 matter filters,
  source-linked work products, UI registry fields, and exportable provenance.
- `npm run check:aletheia:knowledge-governance` verifies matter-scoped Matter
  Memory, human-approved Matter Playbooks, draft-only improvement proposals, no
  global legal memory, and no default Tool Adapter mutation path.
- `npm run check:aletheia:audit-workbench` verifies Evidence, Reviews, and
  Audit registry filters, filtered JSON exports, matter readiness packets,
  matter-scoped `registry_snapshot` saves, UI smoke coverage, and local
  snapshot audit events.
- `npm run check:aletheia:tool-policy` verifies the HTTP Tool Adapter and stdio
  MCP wrapper expose only the approved allowlist and keep high-risk automation
  tools disabled.
- `npm run check:aletheia:approval-policy` verifies high-risk export approval
  gates, human-approved playbook updates, external-source controls, and
  regression/audit coverage.
- `npm run check:aletheia:matter-isolation` verifies matter/user scoped access,
  matter-scoped memory/playbooks, per-matter retrieval indexes, and cross-matter
  retrieval eval coverage.
- `npm run check:aletheia:run-trace` verifies AgentRun, AgentStep, ToolCall,
  and HumanCheckpoint persistence, Workflow Graph controls, high-risk approval
  gates, resume behavior, and Run Trace UI/docs coverage.
- `npm run check:aletheia:evidence` produces the release evidence manifest for
  the current git commit, validation commands, screenshots, and deployment docs.
- `npm run check:aletheia:audit-integrity` verifies that local export work
  products have audit events, export files, local paths, and approved checkpoint
  links for high-risk exports. Its output includes byte counts and sha256 hashes
  for local export files.
- `npm run test:aletheia:local` passes.
- `npm run test:aletheia:litigation-tasks` verifies that only confirmed or
  completed deadlines enter the persistent work queue, including idempotency,
  user isolation, completion/reopen, audit events, and SQLite constraints.
- `npm run test:aletheia:restore-drill` proves backup, restore, and audit
  integrity against a real generated local matter, not just an empty data
  directory.
- `npm run seed:aletheia:ui-smoke` creates a screenshot-ready matter.
- `npm run dev:aletheia:local` starts or reuses local frontend/backend servers.
- `npm run mcp:aletheia` works as a stdio MCP server.
- `npm run package:aletheia:local` generates a private local package manifest
  without bundling client data.
- `npm run test:aletheia:package` fails if required build output, deployment
  docs, attribution notices, or demo evidence docs are missing.
- Documents, exports, SQLite DB, and indexes stay under `.data/aletheia`.
- Audit Pack, Feedback Dataset, and Final Memo exports require approved
  checkpoints.
- Matter Memory remains matter-scoped.
- Playbook updates require human approval.

## Data Directory

Default:

```text
.data/aletheia/
  aletheia.db
  documents/
  exports/
  index/
```

Packaging should allow an operator to choose a data directory. Do not silently
store client data inside a public synced folder.

## Process Model

Minimum local process set:

```text
Aletheia launcher
-> backend process
-> frontend process
-> optional MCP process started by MCP client
```

MCP should remain stdio-launched by the client where possible, not a broad
network service.

## Privacy Defaults

- External web search disabled.
- Browser automation disabled.
- Terminal execution disabled.
- Email disabled.
- Destructive file operations disabled.
- Cloud model fallback disabled unless explicitly configured.
- External embedding provider disabled unless explicitly configured.

## Backup / Restore

Back up together:

- `.data/aletheia/aletheia.db`
- `.data/aletheia/documents/`
- `.data/aletheia/exports/`
- `.data/aletheia/index/`

Restore should verify:

- the restore source stays inside the expected local data boundary;
- backup content does not contain symlinks that escape the workspace;
- SQLite `quick_check` passes;
- core Aletheia tables exist;
- matters load;
- documents can be searched;
- evidence items retain source chunk IDs;
- audit events still reference export paths;
- exported JSON files have recorded byte counts and sha256 hashes;
- high-risk export audit events retain approved checkpoint IDs;
- run traces still render.

## Preflight

```bash
cd backend
npm run build
npm run check:aletheia:preflight
npm run check:aletheia:doctor
npm run check:aletheia:backup
ALETHEIA_RESTORE_SOURCE_DIR=.data/aletheia npm run check:aletheia:restore
npm run check:aletheia:privacy
npm run check:aletheia:ops-readiness
npm run check:aletheia:source-provenance
npm run check:aletheia:knowledge-governance
npm run check:aletheia:audit-workbench
npm run check:aletheia:tool-policy
npm run check:aletheia:approval-policy
npm run check:aletheia:matter-isolation
npm run check:aletheia:run-trace
ALETHEIA_RELEASE_EVIDENCE_OUT=../release-evidence.json npm run check:aletheia:evidence
ALETHEIA_AUDIT_SOURCE_DIR=.data/aletheia npm run check:aletheia:audit-integrity
npm run test:aletheia:local
npm run test:aletheia:restore-drill
npm run seed:aletheia:ui-smoke
npm run package:aletheia:local
npm run test:aletheia:package
```

```bash
cd frontend
npm run build

cd ../desktop
npm run test:sqlcipher-runtime
npm run test:legacy-migration
npm run prepare:frontend-runtime
npm run check:package-hygiene
npm run test:signing-pipeline
npm run pack:mac
npm run test:packaged-app
```

Manual browser check:

- open `/aletheia`;
- open the seeded matter URL;
- queue an Agent Run;
- verify Run Trace, Matter Memory, Playbooks, Evidence Matrix, Draft Memo, and
  Audit Pack are visible.

## Known Packaging Risks

- Node 22 currently prints an ExperimentalWarning for `node:sqlite`.
- Local vector retrieval is not packaged yet; SQLite FTS5 is the current
  supported local retrieval layer.
- Browser-only production builds still need `NEXT_PUBLIC_API_BASE_URL` at build
  time. The Electron package instead resolves its backend URL through the
  trusted runtime bridge.
- Generated shell launchers are a packaging prototype. A signed desktop app or
  installer still needs operator-specific hardening.

The packaged runtime must contain only the compiled local backend. Verify that
desktop resources do not include legacy SQL schemas/migrations and that child
processes use the reviewed local environment allowlist. The default macOS build
has no application signature and is local-only until an Apple Developer ID is
available; a linker-generated ad-hoc Mach-O marker is not a release signature.

## macOS Distribution Gate

The default `./scripts/package-desktop-mac.sh` build is local-only and must
report `signed=false notarized=false`. It clears signing and notarization
environment variables for the Electron Builder invocation and never submits an
artifact to Apple.

Developer ID signing and notarization are blocked until real Apple credentials
are provided outside this repository. There is no claim that Vera is notarized
today. A distributable build must use `VERA_RELEASE_SIGNING=true` and pass
`npm run signing:preflight` before any application build begins. It requires a
non-ad-hoc `CSC_NAME="Developer ID Application: ... (TEAMID)"` plus exactly one
complete, team-matched method:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or
- `APPLE_API_KEY` (readable `.p8` file), `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`.

When `CSC_LINK` is not used, the release CLI preflight also runs
`security find-identity -v -p codesigning` and requires an exact match for
`CSC_NAME` in the macOS keychain. Preflight reports requirements only; actual
`signed=true notarized=true` is emitted solely after release verification.

Release packaging notarizes in `afterSign`, validates the stapled ticket, then
requires `codesign --verify --deep --strict`, Developer ID authority/team
inspection, `spctl --assess`, `xcrun stapler validate`, and SHA-256 manifest
verification. Run `npm run test:signing-pipeline` to audit credential
classification and static linkage offline; it uses fixtures only and performs
no network call.
