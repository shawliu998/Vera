> **Historical Aletheia research material.** This document is not authoritative for the current Vera product or UI. Use the root [PRODUCT.md](../PRODUCT.md) instead.

# Product Thesis

Aletheia 明证 is built for sensitive professional document work where the cost
of an unsupported answer is high.

The core product belief is simple: the agent should not hide behind a final answer. It should expose the plan, assumptions, source evidence, missing materials, review status, and audit trail that allow an expert to trust or reject the output.

## Why Not A Chatbot

Chat is useful for exploration, but sensitive professional work usually ends in
structured work products:

- memos;
- issue maps;
- evidence matrices;
- obligation registers;
- red flag dashboards;
- remediation trackers;
- audit packs.

Aletheia 明证 makes those artifacts the primary product surface. Chat can remain a supporting interface, but it is not the workflow.

The product shape is Kernel plus Domain Packs. The Aletheia Kernel provides the
local vault, bounded agent loop runtime, typed artifact graph, permission/tool
policy, review/gate console, audit trace, eval replay, and human-approved
skills. Domain Packs configure that Kernel for specific workflows. The first
public/private-pilot pack is Private Contract / Due Diligence Review.

The MVP exports this posture into two concrete artifacts:

- Audit Pack JSON: one portable bundle for matter profile, documents, workflow artifacts, review log, audit log, and validation checks.
- Feedback Eval Dataset JSON: expert feedback mapped back to claims, memo sections, and source evidence for future evals and regression tests.

## Shared Workflow

```text
Local Matter Vault
-> Document Upload / Document Registry
-> Agent Plan
-> Document Understanding
-> Evidence Mapping
-> Domain Analysis
-> Draft Work Product
-> Human Review
-> Gate Decision
-> Audit Log
-> Feedback / Eval Export
```

The same Kernel can support compliance obligation, audit evidence, regulatory
response, and litigation chronology packs without making the product a generic
multi-industry SaaS.

## AGI Product Relevance

Aletheia demonstrates business judgment around agent deployment:

- keep experts in control;
- bind conclusions to evidence;
- expose uncertainty and missing facts;
- capture review feedback;
- turn badcases into future eval assets.
