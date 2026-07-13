# Local-Only Product Boundary

Aletheia has one runtime storage path:

```text
Aletheia routes -> AletheiaRepository -> LocalAletheiaRepository
```

The backend entry point mounts only `/aletheia` and `/health`. There is no
runtime switch that can re-enable the inherited chat, project, user, workflow,
download, or case-law routers. The production TypeScript build starts at
`src/index.ts`. The inherited cloud SQL schema and migration archive have been
removed; local SQLite schema is owned and evolved by the local repository.

SQLite, source documents, exports, indexes, durable run state, approvals, and
audit chains remain on the local machine. Local model endpoints are restricted
to loopback. External-source network access is disabled unless an operator
configures an explicit domain allowlist and the matter receives the required
approval.

## Desktop Process Boundary

The desktop main process creates a fresh private token for each launch and
starts the backend and frontend on loopback. Child processes receive an
explicit environment allowlist: normal shell cloud credentials, proxy
variables, and Node injection options are not inherited. Only operating-system
runtime fields and reviewed Aletheia local configuration are forwarded.

Application-encryption material comes from macOS Keychain or an explicitly
configured local key source. Audit-anchor paths, local-model configuration,
durable-worker settings, and malware/CDR configuration remain available as
local operator controls.

## Repository Hygiene Rule

Do not add a cloud SDK back to a package manifest, reintroduce a legacy SQL
schema or migration archive, or expose inherited cloud routes through desktop
or Docker configuration. Release validation scans the compiled backend and
packaged desktop resources for those regressions.
