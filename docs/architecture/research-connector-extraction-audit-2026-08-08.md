# Research connector extraction audit — 2026-08-08

Product authority: [`PRODUCT.md`](../../PRODUCT.md)

Architecture authority: [`vera-kernel-v1.md`](./vera-kernel-v1.md)

This audit records how the untracked legal and patent research implementation
in `/Users/a1-6/Documents/new agent` is being preserved and selectively
extracted. The original worktree remains untouched. No directory is copied as
a unit and no research-only persistence stack or route family is authorized.

## Current boundary

The shared Kernel owns fixed connector pins, fresh runtime authorization,
minimal egress, timeout and provider classification, bounded normalization,
body-free receipts, and the separation between:

- a `discovery`, which is search metadata, is explicitly non-citable, and may
  be presented for selection; and
- a `snapshot`, which contains fixed source text and a digest, remains on an
  import-only channel, and is not a Vera source until the central Matter
  `Document`/`DocumentVersion` importer commits it.

Provider Packs own endpoint calls and provider-specific normalization. They do
not define permissions, Task states, Matter identity, Artifact identity,
approval, export, or a second source database.

## Old implementation disposition

| Old slice | Useful content | Decision | Reason / required adaptation |
| --- | --- | --- | --- |
| `legalSourcesTools/legalSourceContracts.ts` | provider pins, coverage gaps, anti-forged Vera identity checks | Extract concepts only | It carries a second grant/receipt contract now superseded by the Kernel. |
| `legalSourcesTools/legalSourceAdapterRegistry.ts` | audited provider hosts, schema versions, read limits, subscription requirements | Rebuild as provider Pack profiles | Static provider facts belong outside the provider-neutral Kernel. |
| `courtListenerLegalSourceAdapter.ts` | case-search normalization, conservative truncation, full-opinion read | Replaced by the first `agent-packs/research` adapter | The old adapter owned timeout and connector receipts. The new adapter uses the Kernel executor and keeps discoveries distinct from snapshots. |
| `authorityImport.ts` | deterministic filename/content hash, Matter ownership, retry recovery | Do not copy; implement one generic source importer | It depends directly on Supabase/storage and an obsolete mutation helper. Legal and patent imports must share one `Document`/`DocumentVersion` seam. |
| `patentSourceContracts.ts` | publication, family, legal-event and provider-snapshot semantics | Retain as Patent Pack schemas | These are domain semantics, not Kernel contracts. Search summaries must become discoveries; selected full text/status records become snapshots. |
| `epoOpsPatentSourceAdapter.ts` | OPS XML parsing and publication normalization | Refactor into bound invoker plus normalizer | Credentials stay in the invoker closure; timeout, host, scope and receipts stay in the Kernel. |
| `patsnapPatentSourceAdapter.ts` | publication/family/legal-status normalization | Refactor into bound invoker plus normalizer | Add current-user credential support without exposing keys or introducing a provider route family. |
| `patentMatterImport.ts` | readable publication/status rendering | Keep rendering as an optional downstream presentation step | A rendered DOCX is not the immutable provider snapshot and must not replace the central source import. |
| `citationResearch*` orchestration | claim planning, provider aggregation, citation verification | Extract after connector/import seams are fixed | It currently duplicates orchestration, grants and result state. Kernel Task/Step/receipt contracts must remain authoritative. |
| `routes/legalResearch.ts` and `routes/projectPatentPriorArt.ts` | endpoint-level use cases | Do not restore as parallel product stacks | Research should enter existing Assistant, Work Task, Matter, Document, Citation and review surfaces. |

## Implemented acceptance evidence

- CourtListener search emits body-free, non-citable discoveries only.
- A selected cluster read emits one content-hashed import-only snapshot.
- API tokens remain in a server-bound invoker closure and never appear in the
  egress payload, discovery, snapshot receipt, or Task receipt.
- Wrong jurisdiction, host, pin, operation, stale authorization and excess
  result bounds fail before or at the fixed boundary.
- Provider capacity, configuration, network, timeout, protocol and structured
  output are separate resumable classifications.
- Kernel production code remains provider-neutral by dependency test.
- A selected snapshot imports idempotently into the existing Matter
  `Document`/`DocumentVersion` model with body-free JSONB provenance; a later
  snapshot creates a new Version of the same Document.
- The service-role-only atomic commit serializes concurrent Version-number
  allocation and current-pointer activation. A local database/storage smoke
  proves create, replay recovery, concurrent conflict, byte readback and cleanup.

## Remaining gates

1. Adapt EPO OPS and PatSnap as Patent Pack invoker/normalizer pairs.
2. Bind each connector to current per-user authorization without copying or
   sharing credentials between users.
3. Run fixture, database, and product-level legal/patent research acceptance;
   then connect the same source seam to litigation authority research.
