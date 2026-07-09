# Local-First Runtime Plan

Aletheia should run as a local-first, privately deployable, auditable agent
workspace. Supabase is the current compatibility adapter, not the product
boundary.

## Storage Target

```text
.data/aletheia/aletheia.db
.data/aletheia/documents/
.data/aletheia/exports/
.data/aletheia/index/
```

- SQLite stores matters, work products, reviews, audit events, agent runs, tool
  calls, and human checkpoints.
- Filesystem storage keeps source documents, rendered exports, parsed text, and
  retrieval indexes.
- A later private deployment can swap SQLite for Postgres and filesystem for
  MinIO/S3 without changing the Aletheia API.

## Runtime Model

```text
AgentRun
-> AgentStep
-> ToolCall
-> HumanCheckpoint
-> WorkProduct
-> AuditEvent
```

The runtime must not hide behind a final answer. It records plan state, source
evidence, tool I/O, validation errors, model profile, human approvals, and
structured artifacts.

## Current State

- `AletheiaRepository` now defines the backend persistence boundary.
- `SupabaseAletheiaRepository` is the default implementation.
- `LocalAletheiaRepository` now persists matters, work products, source-linked
  evidence items, reviews, audit events, and agent runs to SQLite.
- Local mode persists uploaded source documents to the filesystem, extracts text
  from PDF/DOCX/TXT/MD files, chunks the text, and indexes chunks with SQLite
  FTS5 for keyword search.
- Search results can be mapped into Evidence Items with source chunk IDs,
  document names, quote offsets, support status, relevance, and audit events.
- Search results expose retrieval rank, score direction, contributing retrieval
  layers, and a plain-language ranking basis so keyword, semantic, and hybrid
  evidence selection can be reviewed without trusting an opaque score.
- Search results now include deterministic claim/issue suggestions. If an
  operator does not provide a claim ID when mapping evidence, local mode derives
  one from the source chunk and records the suggestion metadata for review.
- Persisted Evidence Items can be compiled into an `issue_map` work product
  with claim grouping, support status counts, representative source quotes,
  open questions, and an `issue_map_generated` audit event.
- The matter workspace renders the latest Issue Map as a review panel with
  claim IDs, support counts, source documents, open questions, and a
  representative quote.
- Issue Map review actions can attach accepted or needs-human-judgment review
  tags directly to the mapped claim, linked work product, and representative
  evidence item, and the workspace echoes those saved tags back on the mapped
  issue card for reviewer continuity.
- Persisted Evidence Items can be compiled into an `evidence_matrix` work
  product with claim grouping, support counts, source chunk anchors, and an
  `evidence_matrix_generated` audit event.
- Evidence matrices can be compiled into deterministic template-specific work
  products with structured review sections and source evidence IDs:
  `draft_memo` for Legal Matter Review, `compliance_register` for Compliance
  Impact Review, and `red_flag_memo` for Deal Due Diligence.
- Agent runs now create a deterministic trace scaffold with workflow steps,
  least-privilege tool calls, an open human checkpoint, and `needs_human`
  status before final reliance.
- Run Trace steps expose bounded specialist roles and allowed tool lists. These
  are inspectable execution roles, not autonomous terminal/browser/email agents.
- Agent runs persist a typed `workflowGraph` in metadata with ordered nodes,
  directed edges, approval-gated transitions, role labels, and allowed tools.
  The UI renders this graph as an auditable topology alongside the step trace.
- Edited/responded checkpoints can resume the local run, append a
  `resume_after_human_checkpoint` step, generate a revised Draft Memo, and write
  an `agent_run_resumed` audit event. The workflow graph records the revision
  branch and return to human review.
- Audit Pack export now requires an approved human checkpoint; direct work
  product creation without approval is rejected by the backend.
- Feedback Dataset export uses the same approval gate before badcases or review
  tags become eval assets.
- Final Memo export uses the same approval gate and writes a finalized
  `final_memo` work product only after explicit human approval.
- Run Trace UI links steps to generated work products and audit events when the
  trace exposes a work product kind or audit action.
- The Audit page now aggregates live local matter details into an Audit
  Workbench with audit timeline, review burden, approval gate counts, work
  products, and per-matter readiness packets.
- Evidence and Reviews pages now aggregate live local repository data across
  matters, with demo fallback only when the API is unavailable.
- Evidence, Reviews, and Audit views now expose local filters for matter text,
  claim/source text, support status, review tag, and audit action so a reviewer
  can quickly locate the source material behind an audit question. Each view can
  export the filtered result set as local JSON with schema version, filters, and
  record counts, or save the filtered result as a matter-scoped
  `registry_snapshot` work product.
- Matter Memory is implemented as matter-scoped, bounded records for confirmed
  facts, output preferences, excluded paths, missing materials, and reviewer
  feedback. It is intentionally not global memory, preventing cross-matter
  contamination.
- Matter Playbooks are implemented as versioned, auditable workflow manuals.
  They start as drafts and require explicit human approval before they can be
  treated as approved professional procedure.
- Playbook Improvement Proposals can be generated from reviewer feedback,
  Matter Memory, and review tags. They are stored as draft playbooks with source
  links and cannot mutate the approved source playbook automatically.
- `npm run check:aletheia:knowledge-governance` verifies that Matter Memory
  remains matter-scoped, Playbooks remain human-approved/versioned, proposals
  stay draft-only, no global legal memory is introduced, and the default Tool
  Adapter does not expose knowledge mutation tools.
- `npm run check:aletheia:audit-workbench` verifies Evidence, Reviews, and
  Audit registry filters, filtered JSON exports, matter readiness packets,
  matter-scoped `registry_snapshot` saves, UI smoke coverage, and local
  snapshot audit events.
- Export-class work products are now written to local JSON files under
  `.data/aletheia/exports/<matterId>/`, and audit events retain the export
  path. This includes filtered registry snapshots, while high-risk Audit Pack,
  Feedback Dataset, and Final Memo exports remain approval-gated.
- The Aletheia Tool Adapter exposes a least-privilege HTTP and stdio MCP
  surface for
  `list_matters`, `read_matter`, `search_matter_documents`,
  `read_evidence_item`, `create_work_product`, `add_review_tag`,
  `append_audit_event`, and `export_audit_pack`.
- `ALETHEIA_AUTH_MODE=single_user` enables local single-user Aletheia routes
  without Supabase auth.
- `20260708_02_aletheia_agent_runtime.sql` adds runtime tables for private or
  Supabase-backed deployments.

## Future Retrieval Hardening

Replace or augment the local-json semantic prototype with a LanceDB adapter
behind `ALETHEIA_SEMANTIC_INDEX_ENABLED=true`, keeping SQLite FTS5 as the
default local retrieval layer.
