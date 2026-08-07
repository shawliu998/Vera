# Kernel v1 extraction sequence

This is the P4 implementation order for [Vera Kernel v1](./vera-kernel-v1.md).
Every batch starts and ends with a buildable, reviewable integration branch.
Source paths refer to the P0 recovery snapshot/dirty tree; they are inputs for
adaptation, not files to copy wholesale.

## Batch 1 — immutable Task contract

Source evidence:

- `backend/src/lib/agentTaskContract.ts` and focused tests;
- current clean Task, Workflow and planner contracts.

Target:

- pure versioned Goal/Artifact assignment schemas;
- explicit Workflow Manifest input;
- ownership/source/version consistency checks with no database, route, model,
  lease or Pack imports.

Gate:

- invalid marked contracts stop before lease RPC, live context, model, planning
  or mutation;
- existing workflow manifest and Agent Task smoke tests remain green.

## Batch 2 — structured outcomes and provider pause

Source evidence:

- current Phase 5 provider capacity/protocol pause commits;
- dirty retry policy and provider adapter tests.

Target:

- one structured issue taxonomy for required input, capacity, timeout,
  protocol, structured-output drift, work-product gap, version drift and
  internal invariant defects;
- provider-neutral resumable outcome mapping.

Gate:

- completed effects remain linked;
- no retryable provider condition produces a failed legal result;
- wrong/missing named tool remains fail-closed and resumable.

## Batch 3 — Context and fixed source receipts

Source evidence:

- `agentTaskContext.ts`;
- pinned read/citation snapshot tests.

Target:

- generic Matter/source/current-Version context and checkpoint merge;
- Pack context extension interface;
- litigation stage/side/scope stays outside the Kernel core.

Gate:

- cross-Matter, deleted and stale Versions fail before provider or mutation;
- resume rehydrates the identical fixed source set.

## Batch 4 — Step contract and capability intersection

Source evidence:

- `agentTaskStepContract.ts`;
- `agentTaskRequiredInput.ts`;
- `agentCapabilityResolver.ts`.

Target:

- generic Step operations/postconditions/receipts;
- required-input schema and replay suppression;
- bounded capability intersection and immutable grant receipt.

Gate:

- an adapter/registry cannot expand host, tool, Matter, Version, mutation or
  egress scope;
- Pack question factories are not imported by Kernel contracts.

## Batch 5 — idempotent effect boundary and execution lease

Source evidence:

- `agentStepIdempotency.ts`;
- `agentTaskExecutionLease.ts`;
- existing Version CAS and Tabular row CAS tests.

Target:

- repository interfaces for reservation, commit, replay and lease;
- lease acquisition only after immutable contract validation;
- generic receipt identity independent of Timeline/Contract/Litigation.

Gate:

- concurrent/replayed effects converge without pointer rollback or duplicate
  Artifact/Review;
- takeover and heartbeat fencing remain intact.

## Batch 6 — verifier core and bounded repair

Source evidence:

- `agentTaskVerifier.ts` split candidates;
- `citationMarkerRepair.ts`;
- Contract, patent and litigation verifier tests.

Target:

- verification packet/current Artifact resolver;
- deterministic current-Version, citation and accepted-view checks;
- structured result normalization;
- Pack verifier profile interface;
- repair eligibility and one-recheck coordinator.

Gate:

- citation marker repair changes only proven markers and preserves accepted
  body text;
- unproven gap preserves the Artifact and routes to review;
- verification never grants approval/export.

## Batch 7 — shared Word and Tabular services

Source evidence:

- Word capability preservation ledger and existing shared tests;
- Tabular row, verification, Memo and export tests.

Target:

- shared current-Version document mutation service;
- shared browser Word/add-in binding and restore contracts;
- decomposed Tabular row/verification/export services.

Gate:

- browser Word/add-in, tracked changes, comments, accepted/rejected view,
  citation focus, Tabular-to-Word and second-browser restore all pass;
- backend Tabular 110-test and frontend 76-test baselines remain green after
  adapting them to the clean branch.

## Batch 8 — research connector boundary

Source evidence:

- legal-source contracts/registry/adapters and Citation Research tests.

Target:

- provider-neutral read-only connector contract;
- immutable normalized source snapshot and typed coverage gap;
- Matter Document/Version import and Citation binding.

Gate:

- resolve the PKULaw `fulltext` input discrepancy from the audited live schema;
- all 215 focused research tests pass;
- provider failure pauses the Step and never fabricates source coverage.

## Commit and review rule

Each batch is one or more small commits, but no commit mixes Kernel contracts,
domain behavior, UI redesign and migrations. Before the next batch:

1. inspect the diff for imports and dependency direction;
2. run the focused old-behavior tests adapted to the clean target;
3. run clean baseline smoke/build checks in proportion to the change;
4. record intentional differences and remaining debt;
5. verify the source dirty tree and recovery bundles are unchanged.

Contract and Litigation gold workflows begin only after Batch 6. Patent source
integration begins only after Batch 8 and migration reconciliation.
