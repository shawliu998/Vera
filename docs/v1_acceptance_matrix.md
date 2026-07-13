# Aletheia V1 Acceptance Matrix

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.**

| Function | Status | Evidence | Limitations |
| --- | --- | --- | --- |
| Matter workspace | Completed for local-only V1 | `/aletheia` workspace, Matter Queue, Remote Matter pages, full desktop/mobile UI smoke | Not production SaaS; inherited application routes remain outside the Aletheia product path |
| Ingestion | Completed for local-only V1 | Local upload, parser/chunk metadata, `needs_ocr`, TXT/DOCX/PDF local regression, `test:aletheia:batch-import-route` | Rich spreadsheet/table semantics and full source-page preview remain limited |
| Retrieval | Completed for local-only V1 | SQLite FTS5 matter-scoped search, local retrieval eval, 24-document compact fixture, source-index route | Semantic/hybrid retrieval remains an opt-in local prototype |
| Source provenance | Completed for local-only V1 | Source chunk IDs, document IDs, quote offsets, support status, source provenance audit | Production-grade external source governance remains future hardening |
| Review Studio | Completed for local-only V1 | Unresolved review visibility, source-linked review anchors, memo badges, review logs, local review-resolution API/status path, persisted review-derived eval cases | Production workflow claims remain out of scope |
| Gates | Completed for local-only V1 | Citation/human approval/missing material/conflict/external source gates, fail-closed final export tests, approval policy audit, persisted gate authorization audit events | Privilege/confidentiality remains a visible caution policy rather than a deeper post-approval policy |
| Runtime / AgentOps | Completed for local-only V1 | Deterministic provider, run trace, token estimates, structured-output guard, `POST /aletheia/matters/:matterId/v1/runtime-results`, local approval retry/resume recording, runtime route audit | Real provider dispatch, exact pricing adapters, and production SaaS runtime claims remain unavailable |
| Export / audit pack | Completed for local-only V1 | `POST /aletheia/matters/:matterId/v1/export-package`, durable eval export route, local JSON export files, SQLite export metadata, `audit_pack.source_index_manifest`, export hash, audit event, export package tests | Production SaaS export infrastructure is not claimed |
| Eval / skills | Completed for local-only V1 | Local review-derived eval persistence, durable eval export, candidate-only skill output, `POST /aletheia/matters/:matterId/skills/approve-candidate`, approved matter-scoped playbook skill, `approved_skill_activated` audit event, V1 contract and focused backend audit tests | Production/global skill registry governance and real-provider eval loops remain future work |
| Deployment docs | Completed for local-only V1 | README, status page, private/local deployment docs, release notes, validation commands | No signed installer, production SSO/session policy, or production SaaS claim |
| UI smoke | Completed for local-only V1 | Full Playwright desktop/mobile smoke passed 6/6 on explicit local backend/frontend ports; focused mobile smoke passed 2/2; frontend typecheck/lint passed | Browser coverage is focused on the validated local path |
