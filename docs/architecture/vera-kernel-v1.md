# Vera Kernel v1

Status: **P3 architecture contract**

Frozen base: `4e5a3d546bd88bf991c8cae8b59d784a3c07d073`

Product authority: [`PRODUCT.md`](../../PRODUCT.md)

Implementation constraints: [`AGENTS.md`](../../AGENTS.md)

This document defines the only target architecture for the current cleanup and
convergence program. It replaces “one large agent runner plus domain-specific
workbenches” with one small server-owned execution Kernel, shared work-product
surfaces and declarative domain Packs. It does not add a product surface or a
new persistence model.

## Product shape

```text
Mike-derived shared product shell
  Assistant | Matters | Library | Workflows | Work Tasks
  Tabular Review | browser Word | Word add-in | Artifact delivery
                         |
                 Agent Kernel v1
  contract validation -> bounded step -> effect receipt -> verification
                         |
       shared document / tabular / source adapters
                         |
      Contract Pack | Litigation Pack | Patent Pack | Research Pack
```

Practice-area landing pages may discover, start and resume Matter-owned work.
They do not own execution, review, editing, sources, delivery or persistence.

## Canonical objects

Kernel v1 reuses the existing objects:

| Need | Canonical object |
| --- | --- |
| ownership and work context | Matter/Project |
| immutable input and generated content | Document + Version |
| source proof and direct navigation | Citation with typed locator |
| long-running work and recovery | AgentTask + Step + checkpoint/result data |
| work-product relationship | ArtifactLink |
| structured evidence/review tables | Tabular Review + existing row/cell contract |
| lawyer decision | Review Decision |
| editable deliverable | current Document Version through browser Word/Word add-in |

No Pack may add a second Task state machine, Artifact graph, evidence registry,
review store, route family, navigation shell or provider scheduler without first
proving these objects cannot carry the requirement and obtaining approval.

## Kernel responsibilities

Kernel v1 owns only horizontal execution guarantees:

1. load the Task and fixed current snapshot;
2. validate ownership and immutable Task, Artifact and Context contracts;
3. bind current source and mutation-target Versions;
4. acquire or confirm an expiring execution lease;
5. resolve the current Step capability against the validated contract;
6. invoke one provider-neutral bounded Step adapter;
7. validate and mechanically normalize structured output;
8. reserve and commit server-bound effects idempotently;
9. write Step/checkpoint/Artifact receipts;
10. run deterministic verification immediately;
11. return clean pass, bounded repair, lawyer review, required input or
    resumable provider pause without discarding completed effects.

Contract validation occurs before leases, model calls, connector calls,
planning writes or mutations. A lease fences concurrent execution; it is not a
substitute for validating the immutable assignment.

Kernel v1 does not decide legal substance, domain table fields, document
sections, replacement wording or professional conclusions. Those belong to a
Pack contract and remain reviewable work product.

## Pack contract

Each Pack is a versioned set of pure configuration and bounded adapters:

```ts
type VeraPackV1 = {
  id: string;
  version: string;
  workflows: WorkflowManifestV1[];
  contextCompiler?: PackContextCompilerV1;
  requiredInputProfiles: RequiredInputProfileV1[];
  stepAdapters: Record<string, BoundedStepAdapterV1>;
  artifactProfiles: ArtifactProfileV1[];
  verifierProfiles: VerifierProfileV1[];
  fixtures: AcceptanceFixtureRefV1[];
};
```

A Workflow Manifest fixes the lawyer objective, supported Matter practice,
required sources, ordered step kinds, expected editable Artifacts and review
gate. The server compiles it into the Task/Step contract. The model may fill a
bounded result but may not replan outside the compiled suffix, select broader
sources or change approval/export.

Pack-specific semantics stay in Pack profiles:

- Contract: proposal identity, `accept/comment/skip`, exact replacement,
  revision/clean/opinion alignment.
- Litigation: stage/side context, Evidence Inventory fields, Case Map
  relationships, typed authority versus record evidence, partial-cell recovery.
- Patent: Office Action/claim/invalidity structures, source snapshot imports,
  provider-specific read-only connector normalization.
- Research: query scope, coverage gaps, authority normalization, source import
  and citation verification.

## Step adapter contract

A bounded Step adapter receives only server-selected inputs:

```ts
type BoundedStepInputV1 = {
  task: FixedTaskContractV1;
  step: FixedStepContractV1;
  matterId: string;
  sourceVersions: FixedSourceVersionV1[];
  mutationTarget?: FixedCurrentVersionV1;
  capabilityGrant: FixedCapabilityGrantV1;
  priorReceipts: EffectReceiptV1[];
};

type BoundedStepOutcomeV1 =
  | { kind: "effect_ready"; output: unknown }
  | { kind: "required_input"; issue: StructuredIssueV1 }
  | { kind: "provider_pause"; issue: StructuredIssueV1 }
  | { kind: "review_required"; issue: StructuredIssueV1 };
```

Adapters do not mutate directly. The Kernel validates output, binds exact
targets, reserves an idempotency key and performs the effect through a
server-owned effect handler.

## Outcome model

Task status, Step execution, verification, lawyer decision and export are
different axes. They must not be collapsed into one `failed/completed` flag.

| Axis | Representative values | Meaning |
| --- | --- | --- |
| Step execution | queued, running, waiting_input, paused, completed, failed | Whether bounded execution can proceed. `failed` is reserved for non-recoverable internal/contract defects. |
| Provider condition | available, capacity, timeout, protocol, structured_output | External execution condition; recoverable cases pause the Step. |
| Verification | pending, clean_pass, review_required | Deterministic/model-assisted work-product check only. |
| Lawyer decision | pending, accept, comment, skip/reject as existing contract permits | Human disposition over fixed work product. |
| Delivery | internal, approval_required, export_ready, exported | Consequential final action controlled by existing gates. |

The UI may show one clear next action but must derive it from these axes rather
than inventing a new combined status.

## Failure and recovery taxonomy

| Class | Example | Kernel action |
| --- | --- | --- |
| required input | missing fixed source or lawyer choice | preserve effects; `waiting_input`; name the exact input needed |
| provider capacity | 429/queue/unavailable | bounded retry; then resumable pause; do not call the legal result failed |
| provider timeout/stream | deadline, truncated SSE | retry only when safe; otherwise resumable pause with receipt |
| provider protocol | missing/wrong forced tool call | pause the existing Step; adapter remains fail-closed |
| mechanical structured drift | nullable omission, identical suffix split | normalize only when provable and record it |
| work-product gap | missing citation, semantic mismatch | preserve Artifact; deterministic repair if eligible, otherwise lawyer review |
| version/ownership drift | stale current Version, cross-Matter source | fail closed before mutation; refresh/review required |
| internal invariant defect | malformed immutable contract, impossible receipt | non-recoverable Step failure with diagnostic; no provider retry |

Resume begins at the affected Step and reuses completed effect receipts. It does
not rerun successful prior Steps or create duplicate Artifacts/Reviews.

## Verify, repair, review

Verification occurs after an Artifact effect is committed, never as a reason to
discard it.

```text
effect committed
  -> deterministic checks
       -> clean_pass
       -> mechanically provable repair -> recheck once
       -> bounded substantive edit path -> recheck once
       -> review_required (Artifact preserved)
```

Repair authorization comes from structured issue codes and server-owned facts.
Human-readable text does not authorize mutation. Citation-marker repair may
change only proven markers on one fixed current DOCX Version and must prove the
accepted-view body is unchanged when markers are removed. Unproven gaps enter
lawyer review.

`clean_pass` never means approved or exportable. Existing Review Decision and
current-Version/hash gates remain authoritative.

## Provider-neutral named tools

The Kernel does not require the model to remember an orchestration ritual when
the server can preload a fixed source or perform a deterministic effect.

When a named tool is genuinely part of the adapter contract, every supported
provider must:

1. precheck one unambiguous registered name and schema;
2. force that current name;
3. validate exactly one completed call before callback/dispatch;
4. reject wrong, missing or out-of-sequence calls;
5. classify incompatibility as a resumable provider-protocol pause.

The adapter may not fall back to a weaker unforced call or widen Matter/source
scope to make a provider succeed.

## Shared Word/document contract

Browser Word editing and the Word add-in are first-class shared capabilities.
Kernel/Pack extraction must preserve:

- browser DOCX open/edit/save;
- Word add-in task restore;
- tracked changes and comments;
- accepted/rejected view integrity;
- Matter-owned current Version and stale-Version conflicts;
- citation/source focus and return navigation;
- Tabular Review to editable Word;
- Contract review revision/clean/opinion relationships;
- long Chinese content and cross-browser/host recovery.

Packs supply document profiles and bounded operations; they do not fork the
editor, add-in bridge, Version model or save path.

## Module target

The first extraction should converge toward small conceptual modules rather
than fixed filenames:

```text
backend/src/lib/agent-kernel/
  contracts/       Task, Context, Step, Required Input
  capability/      bounded grant intersection
  execution/       coordinator and lease repository
  effects/         idempotent reservation/commit receipts
  outcomes/        structured issue taxonomy and pause mapping
  verification/    packet, deterministic checks, repair eligibility

backend/src/lib/packs/
  contract/
  litigation/
  patent/
  research/
```

Existing routes remain shallow adapters during extraction. Directories are not
new persistence or product surfaces. Exact filenames may adapt to repository
conventions, but dependency direction is fixed: Packs depend on Kernel
contracts; the Kernel never imports a Pack implementation.

## Dependency rules

1. Routes and UI depend on application services, not provider adapters.
2. Kernel contracts have no route, UI, database-client or Pack imports.
3. Execution coordinator depends on repository/effect interfaces, not global
   database objects.
4. Pack verifier profiles return structured checks; only the Kernel coordinates
   Task transitions and repair dispatch.
5. Source adapters return normalized immutable snapshots and typed coverage
   gaps; they do not create legal conclusions.
6. Shared document and Tabular services enforce Matter/Version/idempotency
   boundaries independent of model behavior.

## P3 acceptance gates

Architecture is frozen only when:

- `AGENTS.md` contains the litigation and reliability constraints;
- historical architecture docs point to this contract;
- the P1 Kernel, Word, Contract, Litigation, Patent, Tabular and research
  ledgers map to these boundaries;
- no new table, state, page, route family or security boundary is proposed;
- the first P4 extraction batch is specified as pure contracts plus tests;
- the existing browser Word and add-in paths remain explicit release gates.

Implementation differences require an architecture decision record and product
approval before code expands beyond these boundaries.
