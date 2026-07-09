# Aletheia V1 Orchestrator Status

## 2026-07-09 Kickoff

### Active Threads

- V1 Supervisor: `019f4609-fe84-7cb1-a34e-36de796f77bc`
- V1 Architecture / Contracts: `019f460a-3771-7e53-b9d8-619042b6475d`

### Active Heartbeats

- `aletheia-v1-orchestrator-adaptive-inspection`: current orchestrator, 1 minute.
- `aletheia-v1-supervisor-adaptive-cycle`: V1 Supervisor, 1 minute.
- `aletheia-v1-architecture-contracts-adaptive-cycle`: V1 Architecture / Contracts, 1 minute.

### Current Phase

Phase 0 / 1: V1 planning and contract freeze.

The orchestrator should not launch all feature windows yet. Launch order:

1. Supervisor + Architecture first.
2. After shared contracts/module boundaries stabilize, launch Document Retrieval, LLM Runtime, and Gate Engine.
3. Then launch Review Studio, Export/Audit, Eval/Skills.
4. Deployment/Docs/Demo runs last to avoid README/release overclaiming.

### Current Target

Aletheia V1 private pilot usable version:

- real document ingestion/retrieval,
- controlled auditable LLM mode,
- bounded agent scheduler,
- expert review UI,
- fail-closed gates,
- professional exports,
- eval replay and skill governance,
- private deployment and truthful docs.
