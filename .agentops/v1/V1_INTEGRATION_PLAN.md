# Aletheia V1 Integration Plan

Updated: 2026-07-09

## Execution Order

1. Supervisor + Architecture / Contracts run first.
2. Architecture freezes shared V1 contracts, fixtures, module boundaries, and status schema.
3. First feature batch: Document Retrieval, LLM Runtime, Gate Engine 2.0.
4. Second feature batch: Review Studio, Export/Audit Pack, Eval/Skills.
5. Deployment/Docs/Demo integrates final public-facing narrative.
6. Orchestrator runs final validation, split commits, push/PR.

## Launch Gate

Feature windows must not start implementation until Architecture / Contracts has published the shared V1 contract baseline:

- canonical Matter, Document, Chunk, Evidence, Claim, Risk, ReviewAction, GateResult, AgentRun, ToolCall, AuditEvent, EvalCase, Skill, ExportManifest, and BackupManifest shapes;
- deterministic fixtures for 20-100 document matter simulation or compact representative equivalents;
- module import boundaries and ownership for shared type, adapter, repository, gate, export, and eval surfaces;
- status JSON schema and rollup expectations for all V1 windows.

Until that baseline exists, Document Retrieval, LLM Runtime, Gate Engine, Review Studio, Export/Audit, Eval/Skills, and Deployment/Docs may only do discovery, gap analysis, and additive planning under `.agentops/v1/`.

## Shared Type Ownership

- Architecture owns shared V1 model definitions, schema guards, fixtures, workflow contracts, IDs, and status helpers.
- Feature windows must extend shared contracts rather than invent parallel models.
- README and release docs are owned by Deployment/Docs with Supervisor review.

## Module Ownership

- Document Retrieval: ingestion, document store, retrieval diagnostics, source previews.
- LLM Runtime: model provider abstraction, scheduler, structured output, run trace.
- Review Studio: expert review actions, review queue, review-to-eval.
- Gate Engine: deterministic gates, export permissions, gate checklist.
- Export Audit: exporters, manifest, audit pack, eval dataset export.
- Eval Skills: eval cases, metrics, replay, skill/playbook governance.
- Deployment Docs: local startup, private deployment, demo script, release notes.

## Conflict Rules

- Do not let all windows edit README at once.
- Do not let all windows edit shared type files at once.
- Backend gate/audit code and frontend gate/export code are high-risk integration surfaces.
- Any schema drift must be reported in `.agentops/v1/status/*.json` and escalated to Supervisor.
- Feature windows must not define private replacements for shared V1 contract objects owned by Architecture / Contracts.

## Test Strategy

- Keep deterministic tests API-key free.
- Add narrow tests per module.
- Final V1 validation should include backend operator/provenance/approval/run-trace/audit checks, frontend lint/typecheck, UI smoke, AgentOps checker, and any V1-specific checks.

## Status Files

Each window writes one file under `.agentops/v1/status/` with:

- agent
- status
- last_cycle_summary
- files_changed
- tests_run
- blockers
- next_actions
