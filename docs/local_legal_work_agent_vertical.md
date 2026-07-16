# Vera Local General Legal Work Agent — Vertical Plan

Date: 2026-07-16

Status: active implementation plan

Baseline: `shawliu998/Vera` `main` at
`5611699e46552a20bf42ce84396a8e65aa139d16`

Feature branch: `feat/local-legal-work-agent`

Workspace schema: v17

## 1. Product objective

The active product is **Vera local general legal workspace**. This vertical
connects one existing Matter, its local documents, the bounded Assistant tool
loop, one authorized legal-research provider boundary, the existing Source
Snapshot/Citation Anchor model, Document Studio, and DOCX delivery.

The target user journey is:

```text
Matter -> documents/OCR -> Assistant task -> local document tools
       -> authorized legal research when available -> cited answer
       -> new Studio Draft -> reviewed suggestion -> DOCX -> restart
```

This work does not introduce a second database, document system, job runtime,
model gateway, editor, active Legacy product, or renderer-side provider client.

## 2. Audited current baseline

| Capability | Current code-backed state |
| --- | --- |
| Desktop lifecycle | Electron supervises one loopback Next.js renderer and one loopback Express backend. |
| Workspace database | One SQLCipher database with contiguous, checksum-recorded migrations through v17. |
| Blob storage | Original and derived payloads use the existing AES-256-GCM local blob boundary. |
| Credentials | Model-provider secrets use the isolated Keychain worker. Retained Legacy legal-source credentials use an application-envelope-encrypted Legacy store and are not an acceptable new active Workspace credential owner. |
| Assistant jobs | `assistant_generate` uses the durable Workspace job repository, pump, fencing, stop, retry, regenerate, recovery, and durable event outbox. |
| Streaming and tools | OpenAI, DeepSeek, Anthropic, Gemini, and hardened OpenAI-compatible adapters support bounded streaming/tool calls through the single model gateway. |
| Current Assistant tools | Production registers `list_documents`, `read_document`, `fetch_documents`, and `find_in_document`; compatible Studio targets additionally register `read_studio_document` and `suggest_studio_edit`. |
| Workflow tool names | `list_workflows` and `read_workflow` exist in the closed Assistant name schema but are not registered or executed by the production tool adapter. `run_workflow` and `get_workflow_run` do not yet exist as Assistant tools. |
| Matter | A Matter is a Project plus the v15-v17 Matter Profile, explicit workspace classification, six capability projections, and unified inference policy. Project ownership remains canonical. |
| Documents and OCR | Project/Matter uploads, parsing, native OCR, status, retry, encrypted originals, source capture, and exact-page reopening are wired. |
| Source identity | Workspace v11-v13 Source Snapshots, source content, Citation Anchors, retention, tombstone, export, and model-use checks are the only active provenance foundation. |
| Document Studio | Blank/Assistant/Workflow drafts, canonical Markdown/TipTap projection, CAS save, immutable versions, restore-as-new-version, citations, bounded AI suggestions, accept/reject/stale checks, and DOCX import/export are wired. |
| Backup and restore | Encrypted backup, restore preflight, restore, failure recovery, and fail-closed desktop startup are wired. |
| Packaged restart | Current packaged E2E proves Matter/Profile/Policy/model/chat/document/source persistence and separately proves OCR -> snapshot/anchor -> Studio -> DOCX -> restart. It does not yet prove the new legal-research-to-Draft vertical. |

Pre-refactor baseline evidence:

```text
npm run build --prefix backend                         PASS
npm run test:workspace:migrations --prefix backend    PASS (v17)
npm run test:workspace:assistant --prefix backend     PASS
npm run test:workspace:assistant-durable --prefix backend PASS
npm run test:workspace:assistant-execution --prefix backend PASS
```

## 3. Reusable owners

The vertical reuses these owners without copying their state:

- `WorkspaceDatabase` and `WORKSPACE_MIGRATIONS`;
- `LocalWorkspaceBlobStore` and blob-record/cleanup repositories;
- `WorkspaceJobPump`, `WorkspaceJobsRepository`, and abort registry;
- `WorkspaceModelProviderRegistry`, model profiles, readiness tests, and
  `WorkspaceInferencePolicy`;
- `AssistantRuntimeService`, `WorkspaceAssistantModelAdapter`, durable chats,
  retrieval chunks, and stream events;
- Project documents and immutable generation snapshots;
- `WorkspaceSourceFoundationRepository` and source-retention lifecycle;
- `WorkspaceDocumentStudioService`, versions, suggestions, and DOCX bridge;
- `WorkflowsService`, `WorkspaceWorkflowRuntime`, and durable workflow runs;
- Matter Profile/API/shell and Project ownership checks;
- existing desktop security, backup/restore, package, and restart gates.

Retained Legacy legal-provider adapters may be studied and extracted only
behind new active Workspace ports. New `/api/v1` code must not call Legacy
routers, repositories, credentials, or `/aletheia/*` endpoints.

## 4. Current gaps

1. `assistantDocumentTools.ts` is a single registration/execution unit. There
   is no composed registry that can safely add Document, Legal Research, Draft,
   and Workflow modules while rejecting global name collisions.
2. The strict frontend Assistant stream contract accepts only the older tool
   set; current Studio tool calls can already be rejected by the client parser.
3. Legal Provider Settings still re-export the Legacy `/aletheia/providers*`
   client. With Legacy routes correctly disabled in the packaged product, the
   active Settings surface can only show an error and is not an active Provider
   Hub.
4. PKULaw and YuanDian code is retained under `lib/aletheia`. Production
   activation is deliberately closed, and no repository evidence proves a
   signed vendor contract, DPA, SLA, retention/export/model-use rights, or a
   live credential on this machine.
5. Legal-search candidates are not current-Matter research-session records and
   cannot safely back `read_legal_source` ownership checks.
6. The Assistant cannot create or read a new Studio Draft. It can only suggest
   against an already attached compatible Studio document.
7. Assistant workflow tools are incomplete and not production registered.
8. The chat UI does not yet expose truthful legal-provider state, localized
   legal tool activity, legal-authority citations, or an Agent-created Draft
   result card that preserves Matter routing.
9. No deterministic packaged E2E covers local documents + test legal provider
   + legal citation + new Draft + suggestion + DOCX + restart.

## 5. Implementation slices and proposed files

### Slice A — documentation truth source

Update:

- `README.md`
- `README_CN.md`
- `docs/status.md`
- `docs/roadmap_legal_workspace.md`
- `docs/vera_legora_harvey_gap_analysis.md`
- this file

### Slice B — Tool Registry, no behavior change

Add:

- `backend/src/lib/workspace/services/assistantToolRegistry.ts`
- `backend/src/scripts/veraWorkspaceAssistantToolRegistryAudit.ts`

Adapt without changing the public `AssistantToolPort` injection seam:

- `backend/src/lib/workspace/services/assistantDocumentTools.ts`
- `backend/src/lib/workspace/runtime.ts`
- `backend/src/lib/workspace/services/assistantRuntime.ts` only if a shared
  exported contract is required;
- `backend/package.json`.

The initial registry contains one module wrapping the existing document/Studio
adapter and preserves its adapter id and exact tool definitions/results. It
rejects duplicate module ids, duplicate tool names, unregistered calls, and
cross-attempt routing. It keeps a bounded registration map and forwards the
existing `AbortSignal` unchanged.

### Slice C — active Legal Provider Hub and research tools

Planned active files are under `backend/src/lib/workspace`, an authenticated
`/api/v1` router, and the existing Settings route. Exact vendor endpoints and
wire fields will be implemented only from official material and authorized
acceptance data. A deterministic fake provider is registered only in tests.

### Slice D — Draft and Workflow tools

Add modules that call existing `WorkspaceDocumentStudioService` and
`WorkflowsService`; do not write renderer-supplied content identities or create
new Draft/Workflow stores.

### Slice E — Assistant loop/UI and packaged vertical

Extend the bounded prompt, budgets, legal source projection, Draft result
card, Matter-safe routes, UI states, and packaged restart E2E.

## 6. Migration plan

The Tool Registry needs **no migration**.

If later slices require durable legal research sessions/candidates,
Assistant-to-Draft links, or user-copyable templates, the next migration is
v18 and is additive, transactional, checksum-recorded, and Project-owned. It
may add only demonstrated owners such as:

```text
legal_research_sessions
legal_search_queries
legal_search_candidates
assistant_artifact_links
legal_document_templates
```

Before v18 lands, the design must prove that existing source snapshots,
anchors, documents, versions, suggestions, chats, jobs, workflows, profiles,
and policies cannot own the required state. Published v1-v17 migrations remain
immutable. Fresh, v14, v17, SQLCipher, backup/restore, and injected rollback
fixtures are mandatory.

## 7. API plan

All new active routes remain under authenticated `/api/v1`. Candidate resource
families are:

```text
/api/v1/legal-providers
/api/v1/matters/:projectId/legal-research/...
/api/v1/matters/:projectId/drafts/...
```

The exact contract lands with its service and tests. It will expose bounded
status and capability projections, never credentials, arbitrary URLs, local
paths, raw provider payloads, or unbounded source text. Provider calls remain
backend-only and enforce HTTPS, allowlisting, redirects, timeouts,
cancellation, response limits, retention, model-use, and Matter ownership.

## 8. Test plan

Tool Registry acceptance:

- empty/duplicate module rejection;
- duplicate global tool name rejection;
- non-registered tool rejection;
- attempt/job isolation;
- bounded route-map eviction;
- AbortSignal identity/cancellation;
- module errors remain safe;
- existing document and Studio tools preserve schemas/results/events;
- existing Assistant build, durable, execution, Matter-policy, Workflow,
  Tabular, OCR, Studio, and migration suites remain green.

Later vertical acceptance adds Provider contract states and security failures,
Draft ownership/version/suggestion/DOCX tests, frontend activity/citation/error
states, a deterministic test-provider E2E, and a distinct live-provider
acceptance that cannot be satisfied by fixtures.

## 9. External blockers

No production legal provider is claimed ready. Before PKULaw or YuanDian can be
activated, the project needs archived official endpoint/search/source-fetch
contracts, the correct credential type, a licensed test account, signed rights
for display/retention/model use/export/onward distribution, applicable DPA and
data-region terms, acceptance queries/sources, and a successful live test.

The current code-owned v13 activation gate remains closed. Test fixtures and
Legacy adapter contract tests prove failure handling, not live legal research.

Signed/notarized distribution is separately blocked on Apple Developer ID and
notarization credentials. Existing local package acceptance remains unsigned,
unnotarized, and local-only.

## 10. Rollback

- Documentation and Tool Registry commits are independently revertible.
- Slice B has no schema or data mutation; rollback restores direct injection of
  `WorkspaceAssistantDocumentTools`.
- Later migrations are additive and are not down-migrated in place. Rollback
  means stop new writes, restore the prior binary only where its schema policy
  permits, or restore a verified pre-upgrade backup.
- Provider activation defaults to unavailable/off. A failed rollout removes
  the credential reference, disables the provider, cancels in-flight calls,
  and leaves already permitted snapshots governed by their recorded retention
  policy.
- Legacy routes/runtime remain default-disabled throughout.

## 11. Completion boundary

This document and the Tool Registry are foundations, not completion of the
vertical. Completion requires a real-model tool loop, truthful authorized
provider behavior, legal-authority snapshots/citations, Agent-created Studio
Draft, reviewed suggestion, DOCX export, restart persistence, packaged E2E, and
all retained P0/P1/security/backup gates. Without licensed live credentials,
the product must report the provider as unavailable and the live-provider
acceptance remains externally blocked.
