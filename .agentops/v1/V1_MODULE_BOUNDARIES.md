# Aletheia V1 Module Boundaries

Updated: 2026-07-09

## Architecture / Contracts

Owns shared V1 types, baseline guards, fixtures, default factories, artifact hashing, BigAt reference helper exposure, and this V1 documentation set.

Architecture changes must stay additive unless the Supervisor coordinates a migration.

## Document Retrieval

Owns ingestion, chunking, retrieval implementation, parser diagnostics, and source previews. It must output `DocumentRecord`, `DocumentChunk`, and `RetrievalResult` compatible objects.

## LLM Runtime

Owns provider configuration, deterministic fallback, run scheduling, structured output handling, and `AgentRun` / `ToolCall` recording. External model calls remain off by default for private data.

## Review Studio

Owns expert review UX and review actions. Review feedback must be represented as `ReviewComment` and may create `EvalCase` records through the shared helper.

## Gate Engine

Owns deterministic gates and export authorization. It must emit shared `GateResult` records and use shared gate summaries for final export checks.

## Export / Audit Pack

Owns professional exports, audit pack manifests, hashes, run traces, tool call logs, human approval logs, and eval dataset exports. It must preserve source IDs and artifact hashes.

## Eval / Skills

Owns deterministic metrics, eval replay, skill/playbook governance, and approval state. Skill candidates must remain inactive until a human approval path marks them approved.

## Deployment / Docs / Demo

Owns README, release notes, demo script, and private-pilot deployment instructions. Other windows should not edit README or deployment docs in parallel.
