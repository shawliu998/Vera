# Product Thesis

Aletheia 明证 is built for high-stakes professional work where the cost of an unsupported answer is high.

The core product belief is simple: the agent should not hide behind a final answer. It should expose the plan, assumptions, source evidence, missing materials, review status, and audit trail that allow an expert to trust or reject the output.

## Why Not A Chatbot

Chat is useful for exploration, but legal, compliance, and diligence work usually ends in structured work products:

- memos;
- issue maps;
- evidence matrices;
- obligation registers;
- red flag dashboards;
- remediation trackers;
- audit packs.

Aletheia 明证 makes those artifacts the primary product surface. Chat can remain a supporting interface, but it is not the workflow.

The MVP exports this posture into two concrete artifacts:

- Audit Pack JSON: one portable bundle for matter profile, documents, workflow artifacts, review log, audit log, and validation checks.
- Feedback Eval Dataset JSON: expert feedback mapped back to claims, memo sections, and source evidence for future evals and regression tests.

## Shared Workflow

```text
Matter Workspace
-> Document Upload / Document Registry
-> Agent Plan
-> Document Understanding
-> Evidence Mapping
-> Domain Analysis
-> Draft Work Product
-> Human Review
-> Audit Log
-> Feedback / Eval Export
```

The same base workflow supports legal matter review, compliance impact assessment, and deal due diligence.

## AGI Product Relevance

Aletheia demonstrates business judgment around agent deployment:

- keep experts in control;
- bind conclusions to evidence;
- expose uncertainty and missing facts;
- capture review feedback;
- turn badcases into future eval assets.
