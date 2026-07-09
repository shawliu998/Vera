# Desktop Packaging Checklist

This checklist is for a private local Aletheia desktop/workstation build. It is
not a release process yet; it defines what must be true before packaging.

## Required Local Capabilities

- `npm run check:aletheia:doctor` passes in the target local/private
  environment.
- `npm run check:aletheia:backup` produces the backup scope manifest.
- `npm run check:aletheia:restore` validates the restore source without
  copying, overwriting, or deleting local data.
- `npm run check:aletheia:privacy` fails on tracked local data, disallowed
  `.env` files, private key blocks, high-confidence API key shapes, or
  non-placeholder private deployment secrets.
- `npm run check:aletheia:tool-policy` verifies the HTTP Tool Adapter and stdio
  MCP wrapper expose only the approved allowlist and keep high-risk automation
  tools disabled.
- `npm run check:aletheia:evidence` produces the release evidence manifest for
  the current git commit, validation commands, screenshots, and deployment docs.
- `npm run check:aletheia:audit-integrity` verifies that local export work
  products have audit events, export files, local paths, and approved checkpoint
  links for high-risk exports. Its output includes byte counts and sha256 hashes
  for local export files.
- `npm run test:aletheia:local` passes.
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
npm run check:aletheia:doctor
npm run check:aletheia:backup
ALETHEIA_RESTORE_SOURCE_DIR=.data/aletheia npm run check:aletheia:restore
npm run check:aletheia:privacy
npm run check:aletheia:tool-policy
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
```

Manual browser check:

- open `/aletheia`;
- open the seeded matter URL;
- queue an Agent Run;
- verify Run Trace, Matter Memory, Playbooks, Evidence Matrix, Draft Memo, and
  Audit Pack are visible.

## Known Packaging Risks

- Node 22 currently prints an ExperimentalWarning for `node:sqlite`.
- The broader inherited app still has Supabase-dependent routes.
- Local vector retrieval is not packaged yet; SQLite FTS5 is the current
  supported local retrieval layer.
- If using production `next start`, `NEXT_PUBLIC_API_BASE_URL` must be set at
  build time.
- Generated shell launchers are a packaging prototype. A signed desktop app or
  installer still needs operator-specific hardening.
