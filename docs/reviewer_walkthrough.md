# Reviewer Walkthrough

This is the fastest path for understanding the Aletheia repository without
reading the whole codebase.

## 1. Product Position

Start with `README.md`.

Aletheia 明证 is not a legal chatbot. It is a local-first MVP/private pilot
candidate for a professional Agent Workspace: an AgentOps + Evidence Workspace
for expert-led legal, compliance, audit, due diligence, and regulatory work.

The core loop is:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## 2. Reviewer Pitch

Read `docs/deepseek_pitch.md`.

The pitch explains why professional AgentOps matters, why high-risk work needs
evidence/review/gates/audit/eval, and how Aletheia adapts ideas from Herdr,
Tutti, and Hermes without becoming a generic autonomous agent console.

## 3. Demo Path

Read `docs/demo_script.md`, then run the local demo if needed:

```bash
cd backend
npm run dev:aletheia:local
```

Open:

```text
http://localhost:3000/aletheia
```

The intended path is:

1. Open or create a Matter.
2. Load sample or uploaded source documents.
3. Inspect the matter workspace.
4. Open the matter-scoped Command Center route when available:
   `/aletheia/matters/[matterId]/agentops`.
5. Treat the generic `/aletheia/agentops` route as a fixture-backed prototype
   view, not persisted product truth.
   The deterministic local demo matter may link there intentionally because its
   source data is fixture-backed.
6. Review source-linked evidence.
7. Inspect the Issue Map and Red Flag Register.
8. Review the draft memo.
9. Flag unsupported claims.
10. Watch gates block final export until citations and human approvals pass.
11. Export Audit Pack and Feedback Eval Dataset.

The current adapter direction is intentionally one-way:

```text
AletheiaMatterDetail + run trace records
-> AgentOps view model
-> Command Center / gates / eval / reference previews
```

That keeps existing Aletheia matter records as the source of truth.

## 4. What To Inspect In The UI

The reviewer path should show:

- Matter profile and document registry.
- Source Map and source-linked Evidence Matrix.
- Issue Map, Risk Register, Red Flag Register, or open questions.
- Draft memo with traceability to evidence and issues.
- Human review tags for unsupported claims, missing facts, overclaims, or
  accepted analysis.
- Trust Gates checklist, blocked/approved export state, and read-only gate
  provenance where available. Gate provenance currently maps display gates back
  to existing Aletheia records; it is not yet a first-class persisted gate
  event model.
- Agent run trace, tool calls, budgets, and human checkpoints where available.
- Audit Workbench, Audit Pack, and Feedback Eval Dataset exports.
- Matter-scoped Command Center cards, Eval Signals, and Big @ reference
  previews as adapter-backed view-layer evidence.
- Route-aware artifact links inside the Command Center. These are currently
  hash anchors into the in-page artifact queue, not durable artifact-detail
  routes.

## 5. Feature Map

Read `docs/feature_map.md`.

The map explains the four product modules:

- Aletheia Core: matter workspace, documents, evidence, work products.
- Aletheia AgentOps: run traces, roles, budgets, tool calls, checkpoints.
- Aletheia Trust Layer: source provenance, review, gates, audit, isolation.
- Aletheia Eval Lab: feedback datasets, retrieval evals, badcase regression.

## 6. Current Status

Read `docs/status.md`.

The important boundary is that Aletheia is a local-first MVP/private pilot
candidate. It has meaningful local validation and demo depth, but it should not
be presented as production-ready legal advice software.

As of the current coordination status, the Matter Command Center is complete
for its view-layer goal. Persistence semantics remain the next boundary: gates,
Big @ references, typed handoff provenance, eval snapshots, and export
provenance still need backend/audit ownership before they can be described as
first-class persisted records.

## 7. Screenshot And Smoke Evidence

For screenshot expectations and automated UI smoke checks, read
`docs/ui_smoke.md`.

Focused adapter-backed route smoke has covered the matter-scoped Command
Center, but the full UI smoke suite is under recovery triage in the current
`.agentops` status. Do not treat a focused route screenshot as a full release
validation substitute.

The screenshot set should show:

- Matter Queue.
- Matter workspace.
- Matter-scoped adapter-backed Command Center.
- Document Registry.
- Source Map.
- Evidence Matrix.
- Issue Map or Red Flag Register.
- Draft Memo.
- Review Queue.
- Trust Gates checklist or gate state.
- Gate provenance if the adapter-backed Command Center route is shown.
- Audit Workbench or Audit Pack.
- Feedback/Eval export.
- Eval Signals or feedback dataset preview.
- Big @ reference previews if the Command Center route is shown.
- In-page artifact queue hash anchors, if artifact navigation is shown.

## 8. What This Proves

Aletheia proves product judgment about professional agents:

- the primary interface is a matter workspace, not a blank chat;
- outputs are typed deliverables, not loose answers;
- claims are evidence-bound;
- experts remain in control;
- gates fail closed for high-risk exports;
- audit and eval are first-class product surfaces.

That is the business-training signal: advanced agents need evidence,
observability, human approval, auditability, and regression loops before they
can be credible in high-risk professional organizations.
