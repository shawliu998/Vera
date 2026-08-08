# Patent prior-art acquisition Work Task — implementation preflight

Date: 2026-08-08

Status: implementation in progress. The Workflow configuration surface and the real missing-credential recovery path have passed their recorded checks; the source-selection and real-provider success gates remain pending, so this is not yet implementation-ready.

## Product and visual truth

- Product authority: `PRODUCT.md`
- Primary Mike source: `docs/screenshots/mike-v040-baseline/agent-task-waiting-input.png`
- Secondary accepted Vera/Mike evidence: `/Users/a1-6/Documents/new agent/artifacts/patentability-matter-search-2026-08-02/README.md`
- Reused surface: existing Agent Task waiting-input region and existing Workflow-use modal.
- Explicit gap from the older Patent search frame: this implementation must finish with an editable Word acquisition record and remain inside the shared Work Task route; the retired `/projects/:id/patent-prior-art` route family is not reused.

## Workflow preflight

| Field | Fixed decision |
| --- | --- |
| Lawyer role | Patent lawyer working in an existing Matter |
| Stage | Prior-art acquisition before patentability, invalidity, FTO, drafting, or filing analysis |
| Primary decision | Approve the exact query scope, then select exact provider discoveries for Matter import |
| Input scope | One or more fixed target DocumentVersions; exact query; one supported publication jurisdiction; exact as-of date |
| Final editable Artifact | Matter-owned Word `Prior art acquisition record` |
| Canonical objects | Matter → AgentTask/Step → fixed connector pin and acquisition checkpoint → lawyer selection → Document/Version → ArtifactLink → Word Artifact → verifier/Review Decision |
| Source path | Selected discovery → canonical publication URL → imported current DocumentVersion → Word citation/source inspector |
| Demo fixture | Existing synthetic patentability fixture plus provider stubs; real-provider acceptance remains a separate EPO gate |

## Inherited-region classification

| Region | Mike source | Decision | Purpose and rationale |
| --- | --- | --- | --- |
| Application shell and breadcrumbs | Agent Task waiting-input screenshot | Keep | Existing Work Task identity and navigation remain recognizable |
| Task title, status and step list | Agent Task waiting-input screenshot | Keep | Existing AgentTask/Step objects already carry progress and recovery |
| Waiting-input notice | Agent Task waiting-input screenshot | Adapt | Explain that bounded discoveries are preserved and require exact lawyer selection |
| Generic supplemental textarea | Agent Task waiting-input screenshot | Remove only for source-selection state | It cannot express an exact discovery identity and currently sends the wrong `/input` transition |
| Selection region | Nearest Mike waiting-input form vocabulary | Adapt | Compact native checkbox rows expose publication title, identifier, date and canonical source without a new page |
| Primary action | Existing waiting-input submit action | Adapt | `Import selected publications and continue` names both lawyer operation and consequence |
| Source details | Accepted Matter-search selected-record evidence | Adapt | Canonical publication opens directly; no model relevance score or invented legal conclusion |
| Deliverable and review surfaces | Existing Agent Task output/review regions | Keep | Word editing, verification, lawyer review, approval and export remain unchanged |

## EPO credential configuration preflight

The real-provider gate requires a current-user EPO OPS consumer key and secret. The backend already exposes a status-only, MFA-gated credential contract, but the product had no browser entry point.

| Field | Fixed decision |
| --- | --- |
| Mike source | Existing `/account/api-keys` page and its `AccountSection`, secret-input, Save/Remove and MFA patterns |
| User | Current signed-in patent lawyer or administrator configuring their own EPO OPS account |
| Primary decision | Save or remove one complete EPO consumer-key/consumer-secret pair |
| Canonical object | Existing encrypted `user_api_keys` record with provider `epo_ops`; not a generic model key or MCP Connector |
| Keep | Settings shell, API Keys navigation, field hierarchy, hidden saved-value status, Save/Remove actions and MFA gate |
| Adapt | One two-field credential block because EPO requires an inseparable key/secret pair |
| Remove | No new connector card, permission page, credential table, or exposed stored value |
| Consequence copy | State that the pair enables bounded EPO publication acquisition and that only the fixed query scope is sent during a Work Task |

## Acceptance gates

The implementation is not final until all are recorded:

- Same-size Mike/Vera waiting-input comparison.
- Native keyboard selection, Enter/Space activation and visible focus.
- Long Chinese publication title and query text.
- 125% and 150% zoom.
- Narrow-window behavior without horizontal page overflow.
- Selected-object synchronization after refresh.
- Exact POST of selected discovery refs and no generic `/input` submission.
- Direct canonical-source opening.
- Current imported DocumentVersion links present before the Word drafting Step begins.
- Provider capacity/configuration interruption preserves the Task and does not claim a failed legal result.

## Recorded configuration-surface results

Tested in the clean worktree on `http://localhost:4173/workflows` with the existing signed-in test account.

| Check | Result | Evidence |
| --- | --- | --- |
| Mike shell reuse | Passed | Existing Workflows page, Modal, project selector, FileDirectory and footer actions are reused; no new page or route was added |
| 1280×720 layout | Passed after repair | `vera-workflow-details-fixed-1280x720.png` and `vera-workflow-details-filled-1280x720.png` |
| Fixed target selection | Passed | `vera-workflow-target-selected-1280x720.png`; `Start Work Task` remained disabled until one Matter document was selected |
| Structured scope gate | Passed | `Next` remained disabled until project, exact query, jurisdiction and as-of date were present |
| Long Chinese text | Passed | `vera-workflow-details-filled-1280x720.png` |
| Visible keyboard focus | Passed | `vera-workflow-keyboard-focus-1280x720.png` |
| Narrow window | Passed | `vera-workflow-details-narrow-640x720.png` and `vera-workflow-details-narrow-480x720.png` |
| 125% effective viewport | Passed | `vera-workflow-details-zoom125-effective-1024x576.png` |
| 150% effective viewport | Passed | `vera-workflow-details-zoom150-effective-853x480.png` |
| Exact creation request shape | Passed | `agentTaskCreationRequest.test.ts` proves the UI emits only `query`, `jurisdiction`, and `as_of_date` under `source_acquisition` |
| Missing EPO credential recovery | Passed | QA Task `c6e41096-311f-4860-9c17-22e5432b508c` is `paused`, not `failed`; `vera-epo-missing-credentials-paused-1280x720.png` |
| Pause reason and next action | Passed after repair | Work heading is `Paused · Acquire bounded prior art`; the visible structured-issue action is `Configure EPO OPS` and the notice says progress is preserved |
| No discovery/import mutation before configuration | Passed | The persisted acquisition checkpoint has empty `search_receipts`, `discoveries`, and `import_receipts`; Task links remain exactly one fixed source Document and the selected Workflow |
| Configuration failure occurs before provider egress | Passed | `readOnlySourceExecution.test.ts` proves disconnected authorization returns `provider_configuration` with an empty `egress_fields_sent`; the real Task persisted `provider_configuration_required` before page 1 |
| Resume idempotency while still unconfigured | Passed | Resuming the same Task updated its checkpoint at `2026-08-08T05:01:43Z` but retained Step attempt 1, zero search/discovery/import receipts, and exactly the original source plus Workflow links; status returned to `paused`, never `failed` |

The first 1280×720 run exposed content overlapping the fixed footer. The repair gives the details content its own bounded vertical scroll region. The 125%/150% checks then exposed a shared fixed-height Modal defect; the shared Modal now retains its 600px normal height but cannot exceed `100dvh - 2rem`, keeping actions reachable in short or zoomed viewports.

## Validation baseline

- Backend build: passed.
- Backend unit suite: 196/196 passed.
- Workflow generator suite: 32/32 passed; 37 active workflows and manifests are synchronized.
- Frontend TypeScript: passed.
- Frontend Agent/source-selection, Workflow, Tabular Review and Word suites: 192/192 passed.
- Frontend production build: passed, including `/account/api-keys`, `/agent-tasks/[id]`, Word and Tabular Review routes.
- Changed-file frontend lint and `git diff --check`: passed.
- Full-repository frontend lint: existing baseline debt remains (18 errors and 39 warnings in unrelated legacy Assistant/Chat, support, hook and shared-component files). This gate is recorded as pending repository cleanup and is not attributed to the files in this Work Task.

Still pending before implementation-ready status:

- Same-size Mike/Vera comparison of the actual `selection_required` Work Task state.
- Checkbox Space activation and selected-object synchronization after a real Task refresh.
- Exact source-selection POST and proof that the generic `/input` endpoint is not used.
- Direct canonical-source opening and imported current DocumentVersion links.
- Real EPO provider success path with a current-user consumer key/secret.
