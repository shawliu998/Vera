> **Historical Aletheia research material.** This document is not authoritative for the current Vera product or UI. Use the root [PRODUCT.md](../PRODUCT.md) instead.

# Aletheia Product Kernel

Aletheia is a local-first agent harness for sensitive professional document
work.

Short version:

```text
Codex for sensitive professional work.
```

Codex moves from repo to agent edits to tests to diff to human review to merge.
Aletheia moves from local matter vault to agent-created professional artifacts
to gates to review packet to expert review to final export.

## Kernel

The Aletheia Kernel is the reusable product core:

- Local Vault;
- Agent Loop Runtime;
- Typed Artifact Graph;
- Permission + Tool Policy;
- Review + Gate Console;
- Audit Trace;
- Eval Replay;
- Human-approved Skills.

The Kernel is local-first by default. Sensitive source documents start in a
local matter vault. External model calls are off by default for sensitive/private
data and must be explicit, configurable, logged, auditable, and bounded by tool
policy if enabled.

## Domain Packs

Domain Packs configure the Kernel for a specific professional workflow. They do
not replace the Kernel safety model.

Initial pack framing:

- Private Contract / Due Diligence Review;
- Compliance Obligation;
- Audit Evidence;
- Regulatory Response;
- Litigation Chronology.

The first public/private-pilot pack is Private Contract / Due Diligence Review.

## Non-Goals

Aletheia is not a legal chatbot, not a generic multi-industry SaaS, not a
replacement for qualified experts, and not a production SaaS claim. It supports
expert review by making source documents, agent runs, artifacts, gates, audit
traces, eval cases, and human-approved skills inspectable.
