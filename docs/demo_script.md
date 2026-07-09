# Demo Script

## Opening Position

"Aletheia 明证 is not a legal chatbot. It is a professional AgentOps +
Evidence Workspace for high-stakes work. The product turns documents and
bounded agent runs into evidence-linked, reviewed, gated, audited, and
eval-ready deliverables."

Current stage: local-first MVP / private pilot candidate.

## Five-Minute Demo Path

1. Open `/aletheia`.
   - "This is the Matter Queue. Aletheia is organized around matters and work
     products, not a blank chat box."

2. Create or open a Matter.
   - "For the demo, I will use a Legal Matter Review matter. The same workspace
     pattern also supports compliance impact review and deal due diligence."

3. Upload or load sample documents.
   - "The workflow starts from a document registry: agreements, emails,
     payment records, demand letters, policy documents, VDR files, or
     regulatory materials."

4. Show the Matter Command Center.
   - "This is the command center: matter profile, documents, agent plan, run
     trace, issue map, evidence matrix, draft work product, review queue, gate
     state, and audit log."
   - "For live matter data, use the matter-scoped Command Center route. The
     generic `/aletheia/agentops` route is a fixture-backed prototype view, not
     the source of truth. The local deterministic demo matter may link there
     intentionally because it is fixture-backed."
   - "Artifact links in the current Command Center are in-page hash anchors
     into the artifact queue, not durable artifact-detail routes."

5. Run or inspect the Evidence Agent output.
   - "The Evidence Agent maps source chunks into evidence items. Evidence is
     not just text; it includes source document IDs, quotes, support status,
     claim links, and provenance."

6. Show Issue/Risk Agent artifacts.
   - "The Issue/Risk Agent converts evidence into an Issue Map and Red Flag
     Register. Issues are grouped by risk and linked back to evidence."

7. Show Memo Agent draft.
   - "The Memo Agent drafts a Red Flag Memo or legal review memo. The key point
     is that the memo is a structured work product with citations, not a
     one-shot answer."

8. Show Review Agent findings.
   - "The Review Agent and the human reviewer can flag unsupported claims,
     missing facts, contradictions, and overclaims. Expert judgment stays in
     the workflow."

9. Show the Gate Engine blocking final export.
   - "The Gate Engine blocks high-risk exports until citation and human
     approval gates pass. If a memo has unsupported claims or missing approval,
     the system fails closed."
   - "Where gate provenance is visible, present it as read-only mapping back to
     existing Aletheia records, not as a new persisted gate source of truth."

10. Expert approves or edits.
    - "The expert can approve, edit, reject, or tag the work. Aletheia is built
      for expert-in-the-loop review, not unsupervised legal advice."

11. Generate Audit Pack.
    - "The Audit Pack packages matter profile, documents, evidence, work
      products, review tags, gate decisions, run trace, audit events, and
      validation status."
    - "In the V1 local private-pilot path, the Remote Matter Command Center can
      fetch the local source-index route and include
      audit_pack.source_index_manifest with document, chunk, and source-link
      counts in the downloaded AgentOps export package."
    - "This source-index manifest path is local-only today; do not present it
      as Supabase-backed or production export infrastructure."

12. Generate Eval Cases.
    - "The feedback export and V1 helper fixtures can turn open review comments
      and failed gates into local replayable eval material, so future changes
      to retrieval, drafting, review, and gates can be tested."
    - "Review-derived eval material is not yet a persisted review-to-eval
      workflow because durable review-resolution API/status semantics are still
      missing."

## V1 Private-Pilot Demo Caveats

- This demo is local/private-pilot only; it is not production SaaS.
- Aletheia supports expert review and auditability, not legal advice generation
  or guaranteed legal correctness.
- Supabase V1 document/chunk/source listing and Supabase V1 runtime persistence
  are unavailable.
- There is no public `persistV1RuntimeResult` route and no approval retry
  wiring for blocked external-provider calls.
- External model calls stay off by default for sensitive/private data. Any
  future external-provider use must be explicit, configurable, logged, and
  auditable.
- The updated Playwright route spec still needs to be run as part of final UI
  smoke validation.

## 2-3 Minute Video Path

Use this path for a short reviewer video where the viewer may only watch the
first 60-90 seconds.

1. Open `/aletheia`.
   - Show that the first screen is a matter-based professional workspace.

2. Create or open a Due Diligence Matter.
   - Use a contract-heavy matter so the workflow reads as deal review, not a
     generic chat demo.

3. Upload or load a contract.
   - Show the document registry and source material before showing any agent
     output.

4. Open the Evidence Matrix.
   - Highlight source-linked evidence, support status, quotes, document IDs,
     and claim links.

5. Open the Red Flag Memo.
   - Show that the memo is a structured diligence work product tied back to
     evidence, not a free-form answer.

6. Show the failed gate.
   - Use a missing human approval or unsupported-claim state to show the system
     fails closed before export.

7. Add human approval.
   - Show the reviewer decision changing the checkpoint/gate state.

8. Export the Audit Pack and Feedback Eval Dataset.
   - Close on the proof trail: documents, evidence, memo, approval, run trace,
     audit events, and eval-ready feedback.

## 60-Second Reviewer Version

"Aletheia is a local-first professional AgentOps + Evidence Workspace. It is
not a chatbot. It demonstrates how agents can support legal, compliance, audit,
due diligence, and regulatory work by making every deliverable evidence-bound,
human-reviewed, gate-controlled, audit-ready, and eval-driven.

The demo path is simple: open a matter, load documents, inspect the Matter
Command Center, map evidence, generate an Issue Map and Red Flag Register,
draft a memo, flag unsupported claims, block export until gates pass, approve as
the expert, then export the Audit Pack and Eval Cases."

For a reviewer-facing path through the repository, use
`docs/reviewer_walkthrough.md`.

## Screenshot Checklist

- Matter Queue with Legal Matter Review visible.
- Matter workspace with document registry and agent plan.
- Matter-scoped adapter-backed Command Center.
- Source Map or material checklist when source documents are loaded.
- Evidence Matrix with source-linked evidence and support status.
- Issue Map or Red Flag Register with risk grouping.
- Draft Memo with citations.
- Review Queue showing unsupported-claim or missing-fact tags.
- Trust Gates checklist or gate state showing blocked or approved export.
- Gate provenance on the adapter-backed Command Center, when available.
- Audit Workbench or Audit Pack export state.
- Feedback/Eval export state.
- Eval Signals and Big @ reference previews when showing the Command Center.
- In-page artifact queue hash anchors when showing Command Center navigation.
