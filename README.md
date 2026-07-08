# Aletheia 明证

Aletheia 明证 is an Agent Workspace for high-stakes professional work.

It turns complex documents into verifiable, reviewable, and auditable expert work products.

This is not a legal chatbot. It demonstrates how agentic systems can support legal matter review, compliance impact assessment, and deal due diligence through evidence-grounded workflows, human review, and audit-ready artifacts.

## Demo Flow

1. Open `/aletheia`.
2. Use the Aletheia nav: Matters, Templates, Evidence, Reviews, and Audit.
3. Open the Legal Matter Review demo matter.
4. Inspect the agent plan, issue map, evidence matrix, draft memo, human review panel, audit log, and feedback summary.
5. Export the Audit Pack JSON and Feedback JSON from the demo workspace.
6. Open the Compliance Impact Review and Deal Due Diligence templates for mock workflow examples.

## Workflow Templates

- Legal Matter Review: full MVP demo with matter intake, chronology, issue map, evidence matrix, draft memo, human review, audit trail, and feedback summary.
- Compliance Impact Review: mock workflow with obligation register, business impact, gap analysis, and remediation tracker.
- Deal Due Diligence Memo: mock workflow with VDR-style red flags, contract risk, diligence questions, and evidence map.

## Architecture

Aletheia adds a structured workspace layer above the existing project, document, model, and storage foundations:

```text
Matter Workspace
  -> Document Registry
  -> Agent Plan
  -> Document Understanding
  -> Evidence Mapping
  -> Domain Analysis
  -> Draft Work Product
  -> Human Review
  -> Audit Log
  -> Feedback / Eval Export
```

Mock-mode business logic is centralized in `frontend/src/aletheia`.
The demo workspace can also export two local JSON artifacts:

- Audit Pack: matter profile, document registry, workflow artifacts, review log, audit log, and validation status.
- Feedback Eval Dataset: expert review tags mapped back to their target claim, evidence, memo section, and supporting citations.

The first database migration for the workspace domain is
`backend/migrations/20260708_01_aletheia_workspace.sql`. It adds matters,
matter documents, work products, evidence items, review items, and audit events.
`backend/migrations/20260708_02_aletheia_agent_runtime.sql` adds the agent
runtime skeleton: runs, steps, tool calls, and human checkpoints.

The first API surface is mounted at `/aletheia` on the backend and currently
supports listing matters, creating a matter, loading a matter, adding review
items, saving structured work products, and appending audit events.
Newly created matters receive a deterministic initial Agent Plan work product so
the workflow starts from a reviewable scaffold even before model integration.

Backend persistence now goes through an Aletheia repository boundary. The
default adapter remains Supabase/Postgres for compatibility with the base
application. A local adapter skeleton is present for the local-first roadmap:
SQLite for structured records and filesystem paths for documents, exports, and
indexes.

The Matter Queue now uses a hybrid data model: it renders deterministic demo
matters immediately, then attempts to load persisted matters from the Aletheia
API. When the backend or Supabase auth is not configured, the UI stays usable in
demo fallback mode.

## How To Run

```bash
cd frontend
npm install
npm run dev
```

Then open:

```text
http://localhost:3000/aletheia
```

The demo workspace is deterministic and does not require an external model API key.

## Mock Mode

Current MVP uses deterministic sample data for stable demo behavior:

- `frontend/src/aletheia/mockData.ts`
- `frontend/src/aletheia/workflow.ts`
- `frontend/src/aletheia/schemas.ts`
- `frontend/src/aletheia/exports.ts`

The next production step is to connect the same structured outputs to document parsing, retrieval, and model validation.

## Screenshots

Placeholder: run the frontend and capture `/aletheia` plus `/aletheia/matters/matter-demo-legal-001`.

## License And Attribution

This repository retains the original open-source license file and attribution notes. See `docs/license_attribution.md`.

## Roadmap

1. Implement the local SQLite/filesystem adapter behind the repository boundary.
2. Replace deterministic scaffolds with validated LLM structured output where appropriate.
3. Connect generated agent outputs to agent runs, tool calls, checkpoints, and persisted work products.
