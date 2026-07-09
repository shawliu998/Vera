# Aletheia Product Shape

Last updated: 2026-07-09

Aletheia is a professional AgentOps + Evidence Workspace for legal, compliance, audit, due diligence, and regulatory work. It is not a legal chatbot and must never be positioned as a replacement for qualified experts. The product supports expert review by turning documents, expert judgment, and bounded agent runs into verifiable deliverables with citations, human review, gates, audit trails, typed artifacts, and eval feedback loops.

The coherent product loop is:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## Aletheia Core

Aletheia Core is the matter-centered workspace where professional work is organized. It owns matters, documents, source chunks, evidence items, work products, review items, and audit events.

Current repo anchors:

- Backend route: `backend/src/routes/aletheia.ts`
- Backend domain/repository boundary: `backend/src/lib/aletheia/`
- Frontend workspace: `frontend/src/aletheia/`
- Next.js routes: `frontend/src/app/aletheia/`
- Database migrations: `backend/migrations/20260708_01_aletheia_workspace.sql` and later Aletheia migrations

## Aletheia AgentOps

Aletheia AgentOps makes each agent run inspectable rather than magical. A run should expose its plan, steps, role labels, budgets, tool calls, checkpoint decisions, errors, source use, and resulting artifacts.

Current repo anchors:

- Agent runtime migration: `backend/migrations/20260708_02_aletheia_agent_runtime.sql`
- Budget policy migration: `backend/migrations/20260709_01_aletheia_agent_budget_policy.sql`
- Runtime UI: `frontend/src/aletheia/RemoteMatterRunTrace.tsx`
- Runtime roadmap: `docs/agent_runtime_roadmap.md`

## Aletheia Trust Layer

The Trust Layer is the non-negotiable professional boundary. It requires source-linked claims, explicit uncertainty, missing material tracking, human review, approval gates for high-risk outputs, least-privilege tools, matter isolation, backup/restore readiness, and audit integrity.

Trust Layer capabilities should fail closed when evidence, authorization, approval, or isolation requirements are not satisfied.

Current repo anchors:

- Audit workbench: `frontend/src/aletheia/AletheiaAuditWorkbench.tsx`
- Approval/final memo migration: `backend/migrations/20260708_04_aletheia_final_memo_approval.sql`
- Tool Adapter: `docs/aletheia_tool_adapter.md`, `backend/src/mcp/aletheiaServer.ts`
- Audit/readiness scripts: `backend/src/scripts/aletheia*Audit.ts`, `backend/src/scripts/aletheia*Preflight.ts`

## Aletheia Eval Lab

Eval Lab turns expert review and badcases into regression assets. It should preserve review tags, claim IDs, evidence IDs, citation support status, and work product sections so changes to retrieval, drafting, review, and gates can be evaluated.

Eval Lab outputs are learning inputs, not autonomous professional conclusions. Eval snapshots must point back to source runs, review comments, review tags, gates, checkpoints, evidence, claims, audit events, feedback exports, and approved playbooks before they are treated as durable regression or skills-loop state.

Current repo anchors:

- Feedback export in the demo/workspace flow
- Retrieval eval: `docs/retrieval_eval.md`, `backend/src/scripts/aletheiaRetrievalEval.ts`
- Completion audit: `backend/src/scripts/aletheiaCompletionAudit.ts`

## Matter Workspace

The Matter Workspace is the primary user surface. It should show matter profile, objective, source documents, agent plan, chronology, issue/risk map, evidence matrix, draft work product, review queue, approval state, run trace, audit trail, and feedback export.

It must make the expert's job easier to inspect and decide, not hide work behind a final answer.

## Agent Command Center

The Agent Command Center is the operational view of bounded professional agents. It should show available workflows, active runs, specialist role labels, budgets, tool allowlists, human checkpoints, failed gates, and next actions.

This should remain connected to matter evidence and audit records. Do not introduce a generic autonomous agent console detached from the Matter Workspace.

Current integration priority: keep Agent Command Center state derived from existing Matter Workspace records and run traces through the adapter. Do not make AgentOps contract fixtures a second source of product truth.

Cycle 20 note: the matter-scoped adapter-backed Command Center route is browser-validated through the full UI smoke path. The remaining product boundary is persistence semantics: gate decisions, unresolved references, eval snapshots, and audit events must still map back to established Aletheia records before they are treated as durable professional state.

Cycle 24 note: adapter-backed AgentOps snapshot actions, Big @ previews, and typed handoff validators are useful reviewer surfaces only when they preserve source provenance. Typed handoff artifacts must carry document, evidence, work product, review, checkpoint, audit, run, feedback, and playbook linkage before any output is treated as final, gated, exported, or learned from.

Cycle 25 note: deterministic eval metrics, candidate skills, and export integrity checks are accepted as helper surfaces. Eval snapshots must remain read-only provenance records until they preserve review, gate, evidence, audit, feedback export, source run, and approved playbook linkage.

Cycle 26 note: read-only gate provenance, Big @ reference audit candidates, typed handoff provenance, generated run audit events, and export hashes are converging. Audit/eval export packages remain previews until they include export provenance that ties those helper surfaces back to persisted Aletheia records and high-risk approval state.

Cycle 27 note: route-aware artifact anchors and Evidence Registry source-reference display improve reviewer navigation, but hash anchors remain in-page UI affordances. First-class artifact URLs require a later route/API/repository contract and must preserve the Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval chain.

Cycle 28 note: full UI smoke remains the broad acceptance signal for the local workspace, Review Studio, and matter-scoped Command Center. Focused route, gate, eval, and export checks are useful handoff evidence, but broad smoke failures must be tracked separately until recovered.

## Typed Artifact Handoff

Typed Artifact Handoff means every meaningful output has a schema, owner, status, provenance, and next gate. Examples include:

- `agent_plan`
- `chronology`
- `issue_map`
- `evidence_matrix`
- `draft_memo`
- `final_memo`
- `compliance_register`
- `red_flag_memo`
- `registry_snapshot`
- `audit_pack`
- `feedback_export`

Artifacts should be handed from agent to expert, expert to gate, gate to audit pack, and review feedback to Eval Lab without losing source IDs or review decisions.

The next product-shape boundary is typed handoff provenance: handoff previews may summarize and validate cross-artifact links, but durable professional artifacts must still point back to persisted Aletheia records and failed/ambiguous support must remain review-visible.

## Gate Engine

The Gate Engine decides whether a professional output can move forward. Gates should check evidence coverage, unsupported claims, contradictory evidence, missing materials, approval status, export policy, tool policy, and matter isolation.

Gate failures should create actionable review state and audit events. They should not be bypassed by UI-only affordances.

## Big @ Context

Big @ Context is Aletheia's shared matter context: uploaded documents, parsed chunks, citations, matter memory, playbooks, prior review decisions, audit events, and run traces. It adapts Tutti-style shared context and artifact handoff to high-stakes professional work.

This context must be matter-scoped by default. No global legal memory should be introduced without explicit product and security review.

## Professional Skills Loop

The Professional Skills Loop adapts Hermes-style learning into governed professional improvement:

1. Expert reviews work.
2. Review tags become structured feedback.
3. Feedback proposes matter-scoped playbook improvements.
4. Humans approve or reject playbook changes.
5. Approved playbooks influence future bounded runs.
6. Eval Lab checks whether quality improves without weakening evidence or gates.

No agent should autonomously rewrite professional playbooks or legal memory.

Cycle 29 note: professional skill activation requires both an approved `ProfessionalSkill` and a human-approved Matter Playbook or approved playbook proposal with approver identity and timestamp. Candidate skills remain inactive learning suggestions.

Cycle 30 note: adapter-backed export package hashes and manifest counts may be visible in the matter-scoped Command Center as reviewer evidence, but visible metadata is not an approved audit pack, backend persistence parity, or product quality claim. Export actions must remain behind approval policy, audit export provenance, and fail-closed gate semantics.

Cycle 31 note: local JSON preview downloads are acceptable as reviewer inspection packages only when they remain clearly unapproved, local-first, and separate from final professional exports, approved audit packs, approved feedback exports, and backend persistence parity.

Cycle 32 note: the remaining product risk is no longer P0 view coverage; it is backend/audit persistence ownership. Gate persistence must come first because approved exports, audit packs, eval snapshots, and durable typed handoff records all depend on persisted passing gate evidence rather than frontend-only gate payloads.

Cycle 33 note: the first backend/audit gate persistence slice should try existing audit events, approval checkpoint payloads, and final memo work product content before adding a new table. The required product boundary is persisted passing gate evidence plus approved checkpoint before final memo export authorization.

Cycle 34 note: backend/audit persistence work is active in a dedicated owner thread. Product coherence now depends on not treating in-progress backend edits as complete until canonical owner status, validation, and populated audit-integrity evidence exist.

Cycle 35 note: backend/audit gate persistence is accepted for the current slice. Final memo export authorization now requires persisted gate snapshot and gate authorization audit events in addition to an approved checkpoint. The next product risk is downstream consumption: export, eval, and typed handoff surfaces must preserve those persisted gate evidence IDs.

Cycle 36 final P0 note: the local-first Aletheia loop is complete and validated for `Evidence -> Issue/Risk -> Memo -> Review -> Gate -> Audit -> Eval`. All feature/status lanes report done, full UI smoke is passing, and high-frequency supervisor heartbeats can remain paused. The remaining operational cleanup is dirty-worktree review and intentional commit grouping; post-P0 work should harden persisted downstream consumption without weakening expert review, gate, audit, or eval boundaries.

Post-P0 pause/resume note: supervisor cycles should resume before any implementation or documentation change that makes stronger product readiness claims, changes approval/gate/audit/export/eval behavior, or introduces new durable persistence semantics. The operational handoff lives in `.agentops/WORKTREE_HANDOFF.md`.

## Audit Pack

The Audit Pack is the portable record of a matter or workflow run. It should include matter profile, document registry, source/evidence registry, work products, review log, gate decisions, agent run trace, tool calls, audit events, validation status, and feedback/eval references.

The Audit Pack is the main proof that a deliverable was evidence-grounded, reviewed, gated, and auditable.

## Product Inspirations, Rebuilt

Aletheia can learn from:

- Herdr-style multi-agent observability: visible agent traces, run health, and coordination.
- Tutti-style shared context and artifact handoff: rich shared context with typed outputs.
- Hermes-style skill/memory/eval loop: improvement from experience.

For Aletheia, those ideas must be rebuilt around evidence, expert review, approval gates, audit trails, matter isolation, and evals for high-stakes professional domains.
