# DeepSeek Pitch: Aletheia 明证

## One-Line Thesis

Aletheia is a professional AgentOps + Evidence Workspace for high-risk work. It
is not a legal chatbot; it turns documents and bounded agent runs into
evidence-linked, reviewed, gated, audited, and eval-ready deliverables.

## Why Professional AgentOps Matters

Most agent demos optimize for impressive answers. Professional work optimizes
for defensible decisions. In legal, compliance, audit, due diligence, and
regulatory settings, a reviewer needs to know:

- what sources were used;
- which claims are supported, contradicted, or unsupported;
- what the agent did step by step;
- where human judgment changed the output;
- whether required gates passed;
- how the final deliverable can be audited later;
- how failures become eval cases for future improvement.

Aletheia treats those requirements as the product surface, not as metadata
hidden behind chat.

## Why High-Risk Work Needs Evidence, Review, Gates, Audit, And Eval

High-risk professional workflows fail when outputs look polished but cannot be
traced. Aletheia is designed around the opposite posture:

- Evidence: every meaningful claim should map back to source documents, source
  chunks, quotes, support status, and provenance.
- Review: experts can accept, edit, reject, or tag claims as unsupported,
  missing facts, overclaims, or accepted analysis.
- Gates: high-risk exports should fail closed until citation coverage and human
  approval checks pass.
- Audit: matter events, agent steps, tool calls, work products, review
  decisions, approvals, and exports should be replayable.
- Eval: review tags and badcases should become structured regression material
  for retrieval, drafting, review, and gate behavior.

The core loop is:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## Inspirations, Rebuilt For Professional Work

Herdr shows the value of multi-agent observability: runs, steps, roles, and
coordination should be visible. Aletheia adapts that idea through matter-scoped
run traces, specialist role labels, tool allowlists, checkpoints, and audit
events.

Tutti shows the value of shared context and handoff: agents work better when
they can pass structured artifacts through a common workspace. Aletheia adapts
that idea through matters, document registries, evidence matrices, issue maps,
red flag registers, memos, review queues, gate states, and audit packs.

Hermes shows the value of skills and memory loops: systems should improve from
experience. Aletheia adapts that idea through matter-scoped memory, approved
playbooks, reviewer feedback, playbook improvement proposals, and eval cases.

## Why Aletheia Is Different

- Evidence-bound: conclusions must stay connected to source documents,
  citations, support status, and provenance.
- Human-approved: expert reviewers remain in control of acceptance, edits,
  approvals, and playbook changes.
- Local-first: the MVP supports local/private workflows with SQLite,
  filesystem document storage, and deterministic demo behavior.
- Audit-ready: agent runs, work products, review tags, gate decisions, and
  exports are structured for inspection.
- Eval-driven: feedback exports turn expert review into future regression
  cases instead of throwaway notes.

## What The Prototype Proves

Aletheia demonstrates that agent products for professional domains should not
center on a blank chat box. They should center on matter context, typed
artifacts, evidence registries, run traces, review queues, gates, audit packs,
and eval loops.

The repository currently shows a local-first MVP/private pilot candidate, not a
production legal advice system. That boundary is intentional: it proves product
judgment around high-risk deployment.

## Founder Fit

The founder profile fits this problem because it combines:

- legal master's background, which gives domain fluency around evidence,
  claims, review, responsibility, and professional risk;
- two years of agent startup experience, which gives practical understanding of
  agent workflows, tool use, memory, and failure modes;
- professional domain insight, which reframes the product away from generic
  chat and toward reviewable deliverables;
- product and engineering prototype ability, shown by a working local-first
  AgentOps + Evidence Workspace with backend, frontend, audits, exports, and
  eval artifacts.

For AGI core business training, the important signal is not that Aletheia
automates legal work. The signal is that it understands how advanced agents must
be packaged for real high-risk organizations: bounded, observable,
evidence-linked, human-approved, auditable, and continuously evaluated.
