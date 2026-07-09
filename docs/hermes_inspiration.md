# Hermes-Inspired Runtime Notes

Aletheia borrows product and runtime ideas from Hermes-style agent systems, but
Hermes is not currently embedded as a runtime dependency.

## Concepts Adapted

### Matter Playbooks

Hermes-style procedural memory maps to Aletheia `Matter Playbooks`.

Examples:

- Legal Matter Review Playbook
- Compliance Impact Review Playbook
- Deal Due Diligence Playbook
- Citation Verification Playbook
- Human Review Playbook

Playbooks must be versioned, auditable, and human-approved before updates are
used in production workflows. Agents should not silently rewrite playbooks.

### Matter Memory

Matter memory is bounded to one matter. It can include:

- confirmed facts;
- preferred output format;
- excluded legal or diligence paths;
- missing and supplemented materials;
- reviewer corrections and prior edits.

There should be no global legal memory that can contaminate unrelated matters.

### Tool Adapter

Aletheia should expose narrow tools rather than a broad automation surface:

```text
list_matters
read_matter
search_matter_documents
read_evidence_item
create_work_product
add_review_tag
append_audit_event
export_audit_pack
```

External agents may use these through MCP later, but Aletheia remains the
system of record for matters, artifacts, reviews, and audit events.

### Human Approval

High-risk actions should require explicit approval:

- generating final memos;
- exporting audit packs;
- using customer documents;
- citing external material;
- modifying playbooks;
- deleting matters;
- writing badcases to eval datasets;
- calling external web or model tools.

### Minimum Tool Surface

Default enabled tools:

- document_parse
- local_search
- evidence_link
- citation_check
- work_product_create
- review_add
- audit_append

Default disabled tools:

- browser automation
- terminal execution
- external web search
- email
- destructive file operations

## Implementation Status

- Agent runtime tables exist for runs, steps, tool calls, and human checkpoints.
- The remote matter page can queue an agent run.
- The remote matter page renders run traces, tool calls, linked work products,
  human checkpoints, and approval decisions.
- Agent runs persist review budgets and trace metrics for steps and tool calls.
- Human checkpoints support approve, reject, edit, and respond decisions.
- Matter Playbooks and Matter Memory are persisted, matter-scoped, and audited.
- The Aletheia Tool Adapter exposes a narrow HTTP tool surface suitable for a
  later MCP bridge.
- A local stdio MCP wrapper exists for smoke coverage; production MCP packaging
  remains pending.
