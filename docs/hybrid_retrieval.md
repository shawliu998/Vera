# Hybrid Retrieval Notes

Aletheia currently uses SQLite FTS5 for local keyword search. This is the right
default for a private, lightweight legal/compliance workspace because it is
embedded, auditable, and easy to back up with the rest of `.data/aletheia`.

## Current Layer

```text
Uploaded document
-> text extraction
-> chunks
-> SQLite table: aletheia_document_chunks
-> SQLite FTS5: aletheia_document_chunks_fts
-> evidence item with source_chunk_id, quote offsets, document metadata
```

This gives deterministic source anchors for Evidence Matrix and Draft Memo
generation.

The API treats retrieval mode as an explicit policy boundary:

```text
ALETHEIA_RETRIEVAL_MODE=keyword
ALETHEIA_SEMANTIC_INDEX_ENABLED=false
ALETHEIA_SEMANTIC_INDEX_DRIVER=disabled
ALETHEIA_SEMANTIC_INDEX_DIR=.data/aletheia/index/semantic-local
```

`keyword` is the only enabled mode by default. Explicit `semantic` or `hybrid`
requests fail closed unless a vetted local semantic index adapter is installed
and enabled. This prevents a demo or private pilot from silently using an
unreviewed retrieval path for legal evidence.

## Local JSON Adapter

The first optional semantic adapter is `local-json`. It is a deterministic,
local-only prototype that stores per-matter chunk vectors under
`.data/aletheia/index/semantic-local`. It does not call external embedding
providers and it does not replace SQLite FTS5 as the default retrieval layer.

All retrieval modes return audit-facing diagnostics: result rank, score
direction, contributing layers, and a plain-language ranking basis. SQLite FTS5
remains the default layer; semantic and hybrid diagnostics are only emitted when
the vetted local semantic adapter is explicitly enabled.

Enable it explicitly:

```text
ALETHEIA_SEMANTIC_INDEX_ENABLED=true
ALETHEIA_SEMANTIC_INDEX_DRIVER=local-json
ALETHEIA_RETRIEVAL_MODE=hybrid
```

Use this adapter to validate the retrieval policy boundary, matter isolation,
and hybrid ranking contract before installing a heavier embedded vector store.

## When To Add Vector Search

Add vector or hybrid retrieval only after the local keyword chain is stable.
Use it for:

- semantic issue spotting across long matter records;
- near-duplicate clause discovery;
- concept search when exact terminology differs;
- diligence red-flag clustering;
- reviewer-focused reranking.

Do not use vector retrieval as the only source path for high-risk work. The
final evidence item should still retain a concrete source chunk, quote, page,
and document ID.

## LanceDB Option

Use LanceDB when the deployment goal is lightweight local desktop or embedded
private workspace.

```text
.data/aletheia/index/lancedb/
  matter_id partition
  chunk_id
  document_id
  embedding
  sparse or keyword metadata
```

Pros:

- embedded local disk model;
- TypeScript-friendly;
- low operational overhead;
- fits local-first demos.

Tradeoffs:

- less mature as a multi-tenant service boundary than Qdrant;
- still needs explicit backup policy for index files.

## Qdrant Option

Use Qdrant when the target is private single-tenant server deployment or hybrid
search with stronger retrieval controls.

```text
qdrant collection: aletheia_chunks
payload:
  matter_id
  document_id
  chunk_id
  page
  section
  quote_start
  quote_end
vectors:
  dense
  sparse
```

Pros:

- mature dense/sparse/hybrid support;
- good filtering by `matter_id`;
- can support reranking pipelines.

Tradeoffs:

- extra service to deploy and back up;
- requires stricter network and access control;
- more operational complexity than SQLite-only local mode.

## Guardrails

- Always filter retrieval by `matter_id`.
- Never inject cross-matter memory or vectors.
- Keep SQLite FTS5 available as the deterministic fallback.
- Store every promoted evidence item with `source_chunk_id`.
- Audit retrieval runs that create work products or evidence.
- Require explicit configuration before calling external embedding providers.

## Recommended Path

1. Keep SQLite FTS5 as the source-of-truth retrieval layer.
2. Keep `npm run test:aletheia:retrieval-eval` green before changing ranking
   behavior or retrieval adapters.
3. Replace or augment the `local-json` prototype with the LanceDB adapter behind
   `ALETHEIA_SEMANTIC_INDEX_ENABLED=true`.
4. Add Qdrant only for private server deployments that need hybrid retrieval at
   scale.
5. Add legal-quality eval cases before changing work-product generation.
