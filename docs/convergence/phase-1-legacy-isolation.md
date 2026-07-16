# Phase 1 — Legacy Runtime Isolation

Date: 2026-07-16

## Completed

The active Vera backend now treats Legacy Aletheia as explicit compatibility
surface rather than an unconditional part of normal desktop startup.

```text
VERA_ENABLE_LEGACY_ROUTES=false
VERA_ENABLE_LEGACY_RUNTIME=false
```

Only the exact lowercase value `true` enables either gate. Missing, empty,
`TRUE`, `1`, and other values stay disabled.

## Behavior matrix

| Routes | Runtime | Behavior                                                                                                                                            |
| ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| false  | false   | Formal Vera default. Legacy router factory and durable/model/voice/demo modules are not loaded by the composition root. `/aletheia/*` is 404.       |
| true   | false   | Explicit compatibility routes. Route-owned Legacy objects may be constructed; the bootstrap durable/model/voice lifecycle and demo seed remain off. |
| false  | true    | Explicit Legacy background runtime without public Legacy routes. Intended only for controlled migration/diagnostic use.                             |
| true   | true    | Full Legacy compatibility mode for retained tests/tools.                                                                                            |

Production desktop child configuration canonicalizes both values and passes
them explicitly. Ambient non-exact values cannot activate Legacy. Compatibility
audits opt in to the minimum flag combination they require.

## Health contract

Existing `vera.workspace` and `vera.audit` fields remain compatible. Health now
also reports:

```json
{
  "matter": { "status": "not_configured" },
  "conversation": { "status": "not_configured" },
  "legacy": {
    "status": "disabled",
    "routesEnabled": false,
    "runtimeEnabled": false
  }
}
```

`matter` and `conversation` are intentionally truthful placeholders until their
module phases land. Formal packaged smoke requires Legacy disabled health and a
404 from a retained Legacy route.

## Files changed

- backend composition/lifecycle and application audit;
- desktop child environment normalization;
- desktop source/security and packaged smoke gates;
- compatibility audits that intentionally need retained Legacy routes;
- sample/Compose configuration;
- this implementation and rollback record.

## Migrations added

None. Phase 1 changes no database schema and deletes no data, table, blob, route
source, test fixture, or packaged Legacy resource.

## Security implications

- Normal desktop startup no longer imports route, durable, model, voice, or demo
  modules owned solely by Legacy composition.
- Disabled routes are absent (404), not handlers that run after Legacy
  constructors.
- The runtime gate covers durable configuration, model/voice shutdown hooks, and
  demo seeding.
- Existing loopback, bearer, mutation guard, encryption, Keychain and
  backup/restore behavior is unchanged.
- Explicit route compatibility can still construct Legacy route-owned database
  and runtime objects; it is not a harmless UI toggle and remains off by
  default.

## Rollback

No data rollback is required. To restore temporary Legacy compatibility, set
the required gate(s) to exact `true` in a controlled test/migration environment.
To roll back the code, revert the Phase 1 commit; no migration or data deletion
must be undone. The formal client should not use flag opt-in as a permanent
product mode.

## Known limitations

- Matter and Conversation modules do not exist yet, so health reports
  `not_configured`.
- Legacy source files, frontend deep links, voice sidecar and package resources
  remain for migration/regression and are `delete-later`.
- This phase does not solve the audited Workspace background-job audit gate or
  migrate Legacy SQLite provider secrets to Keychain.
- A fresh `Vera.app` packaged smoke is required when a new package is produced;
  source gates do not substitute for that release artifact.

## Tests

Phase-specific and existing regression coverage includes:

```text
backend build
backend test:workspace:application
backend test:workspace:p0-client
backend test:workspace:p1-convergence
frontend lint / build / test:p0-client
desktop test:p0-source
desktop test:sqlcipher-runtime
desktop product/runtime-security checks
git diff --check
```

## Next phase

Phase 2 starts with additive Workspace migration v15 and MatterProfile
repository/service/API tests. Navigation changes follow in a separate UI commit
after the technical Project-to-Matter extension is verified.
