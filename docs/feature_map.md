# Feature Map

Current stage: **local-first MVP / private pilot candidate**. This repository
shows a professional prototype and validation posture; it should not be
overclaimed as production-ready SaaS, legal advice software, or a replacement
for expert judgment.

## Product Shape

Aletheia is a local-first agent harness for sensitive professional document
work. Read the system as an Aletheia Kernel plus Domain Packs.

## Aletheia Kernel

Purpose: reusable local-first harness for bounded professional agent loops.

Key surfaces:

- Local Vault: Matter Queue, matter profile, Document Registry, SQLite,
  filesystem documents, local exports, deterministic fallback data, and private
  pilot defaults.
- Agent Loop Runtime: bounded run traces with steps, specialist role labels,
  budgets, tool calls, workflow graph metadata, and human checkpoints.
- Typed Artifact Graph: plans, evidence, issues, registers, memos, snapshots,
  audit packs, feedback exports, and final exports.
- Permission + Tool Policy: narrow Tool Adapter and least-privilege policy for
  approved external-agent access.
- Review + Gate Console: human review tags, unsupported-claim flags, approval
  checkpoints, and fail-closed high-risk export gates.
- Audit Trace: Audit Workbench, reviewable events, registry snapshots, JSON
  exports, source provenance, and matter isolation.
- Eval Replay: feedback datasets, retrieval evals, completion/source-provenance
  audits, badcase regression, and playbook improvement proposals.
- Human-approved Skills: matter-scoped memory, approved playbooks, candidate
  skill proposals, and no autonomous playbook mutation.

Representative artifacts:

- `agent_plan`
- `chronology`
- `issue_map`
- `evidence_matrix`
- `draft_memo`
- `compliance_register`
- `red_flag_memo`
- `final_memo`

Status: MVP path exists for local demos and private pilot evaluation. Storage
is local SQLite plus owner-only filesystem data.

## Domain Packs

Purpose: configure the Kernel for specific sensitive-work workflows.

- Private Contract / Due Diligence Review Pack: first public/private-pilot pack
  with source-linked contracts, issue maps, evidence matrices, red flag memos,
  diligence questions, review packets, gates, audit packs, and eval cases.
- Compliance Obligation Pack: obligation/control evidence, Compliance Register,
  human review, gate checks, and audit trail.
- Audit Evidence Pack: workpaper/control evidence review, source support checks,
  readiness packets, and audit exports.
- Regulatory Response Pack: response chronology, source support, review tags,
  approval gates, and export packet.
- Litigation Chronology Pack: event chronology, document anchors, open issues,
  review notes, and audit trail.

Status: the local MVP path exists for demos and private pilot evaluation. The
first pack should lead public storytelling. Production SaaS deployment remains
outside the current boundary.

## Reviewer Takeaway

Aletheia demonstrates a product thesis for sensitive professional agents:

```text
Documents + Agent Runs
-> Evidence
-> Issues/Risks
-> Draft Work Products
-> Expert Review
-> Approval Gates
-> Audit Pack
-> Eval Cases
```

The meaningful innovation is not "AI answers legal questions." The meaningful
innovation is a governed workspace where high-risk professional outputs are
evidence-bound, human-approved, audit-ready, and eval-driven.
