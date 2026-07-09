# Aletheia V1 Acceptance Criteria

Updated: 2026-07-09

## Ingestion

- Import or seed a matter with 20-100 documents or representative compact fixtures.
- Preserve filename, type, size, hash, status, page/sheet/section metadata where available.
- Mark scanned or unparsable PDFs as `needs_ocr` or `failed`; do not silently treat them as parsed.

## Retrieval

- Search is matter-scoped.
- Retrieval results include document ID, chunk ID, score, quote preview, retrieval method, and ranking basis.
- Evidence items resolve back to source chunk/document metadata.

## LLM Mode

- Deterministic provider works without API keys.
- External providers are configurable and off by default for private/sensitive data.
- Model calls are logged as ToolCall / AgentRun / AuditEvent.
- Structured outputs are schema-guarded.

## Agent Runs

- Runs are bounded cycles: Observe -> Plan -> Act -> Persist -> Gate -> Report.
- Status supports queued, working, blocked, review_needed, waiting_for_approval, done, failed.
- Blocked runs write blocked reason and next action.
- Budget/token/cost metadata is recorded where available.

## Review

- Expert users can review without editing raw JSON.
- Review comments attach to artifact and anchor.
- Evidence, risks, memo sections, and final export approval support explicit review actions.
- Review actions write audit events and can create candidate eval cases.

## Gates

- Citation, human approval, missing material, conflict, scope/jurisdiction, privilege/confidentiality, external source, and export gates exist.
- Final export fails closed when blocking gates fail.
- Draft export can proceed with warnings.
- Gate failures show required action.

## Exports

- Evidence matrix and risk register export to CSV/XLSX or documented fallback.
- Draft memo exports to DOCX/PDF/HTML or documented fallback.
- Final memo respects gates and approval.
- Audit pack includes manifest, hashes, evidence, review, gates, audit events, run traces, and tool calls.
- Eval dataset exports JSONL or documented fallback.

## Eval + Skills

- Review comments and gate failures can create EvalCase records.
- Deterministic metrics include citation coverage, unsupported claims, overrides, gate failures, and export readiness.
- Candidate skills require human approval before activation.
- Approved/rejected/deprecated skill states are represented.

## Deployment / Backup / Docs

- README and docs describe local/private pilot setup truthfully.
- Privacy and external model risk are explicit.
- Backup/restore and audit-integrity checks are documented.
- Demo script matches implemented features.
- Release notes distinguish working, partial, and planned capabilities.
