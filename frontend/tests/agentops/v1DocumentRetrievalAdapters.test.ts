import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AletheiaDocumentSearchResult,
  AletheiaMatterDetail,
} from "../../src/app/lib/aletheiaApi";
import {
  v1DocumentChunkFromSearchResult,
  v1DocumentRecords,
  v1EvidenceSourceChunks,
  v1RetrievalResultFromSearchResult,
} from "../../src/aletheia/remoteMatterTransforms";
import { validateV1ArtifactShape } from "../../src/aletheia/agentops/v1Contracts";

const now = "2026-07-09T09:00:00.000Z";

const detail = {
  matter: {
    id: "matter-v1-document-adapter",
    user_id: "user-v1",
    title: "V1 Document Adapter Matter",
    template: "deal_due_diligence",
    status: "in_progress",
    client_or_project: "Private Pilot",
    objective: "Validate V1 document retrieval adapters.",
    risk_level: "high",
    source_project_id: null,
    shared_with: [],
    metadata: {},
    created_at: now,
    updated_at: now,
  },
  documents: [
    {
      id: "matter-doc-text",
      matter_id: "matter-v1-document-adapter",
      user_id: "user-v1",
      document_id: null,
      name: "Master Services Agreement.pdf",
      document_type: "contract",
      parsed_status: "parsed",
      summary: "Master services agreement with notice provisions.",
      metadata: {
        hash: "sha256:msa",
        mimeType: "application/pdf",
        sizeBytes: 4096,
        pageCount: 12,
        parser: "aletheia-local-v0",
      },
      created_at: now,
      updated_at: now,
    },
    {
      id: "matter-doc-scan",
      matter_id: "matter-v1-document-adapter",
      user_id: "user-v1",
      document_id: null,
      name: "Scanned Disclosure Schedule.pdf",
      document_type: "pdf",
      parsed_status: "needs_ocr",
      summary: "PDF uploaded but no text layer was detected; OCR is required before indexing.",
      metadata: {
        mimeType: "application/pdf",
        sizeBytes: 8192,
        chunkCount: 0,
        needsOcr: true,
        parseFailureReason: "pdf_without_text_layer",
      },
      created_at: now,
      updated_at: now,
    },
  ],
  workProducts: [],
  evidence: [
    {
      id: "evidence-notice",
      matter_id: "matter-v1-document-adapter",
      work_product_id: null,
      document_id: "matter-doc-text",
      source_chunk_id: "chunk-notice",
      claim_id: "claim-notice-window",
      document_name: "Master Services Agreement.pdf",
      page: 12,
      section: "8.2 Security Incident Notice",
      quote:
        "Vendor must notify Customer within 48 hours after confirming a security incident.",
      quote_start: 1200,
      quote_end: 1281,
      relevance: "direct",
      support_status: "supports",
      confidence: "high",
      metadata: {
        normalizedFact:
          "The agreement requires notice within 48 hours after incident confirmation.",
      },
      created_at: now,
    },
  ],
  reviews: [],
  auditEvents: [],
  agentRuns: [],
  matterMemory: [],
  playbooks: [],
} satisfies AletheiaMatterDetail;

const searchResult = {
  id: "retrieval:matter-v1-document-adapter:chunk-notice:keyword:1",
  chunk_id: "chunk-notice",
  matter_id: "matter-v1-document-adapter",
  document_id: "matter-doc-text",
  document_name: "Master Services Agreement.pdf",
  text: "Vendor must notify Customer within 48 hours after confirming a security incident.",
  chunk_index: 3,
  page: 12,
  section: "8.2 Security Incident Notice",
  quote_start: 1200,
  quote_end: 1281,
  score: -4.25,
  quote_preview:
    "Vendor must notify Customer within 48 hours after confirming a security incident.",
  method: "keyword",
  ranking_basis: "SQLite FTS5 BM25 keyword match",
  retrieval_mode: "keyword",
  retrieval_layers: ["sqlite_fts5"],
  retrieval_rank: 1,
  retrieval_score: -4.25,
  retrieval_score_direction: "lower_is_better",
  retrieval_explanation: {
    rank: 1,
    score: -4.25,
    scoreDirection: "lower_is_better",
    basis: "SQLite FTS5 BM25 keyword match",
    layers: ["sqlite_fts5"],
  },
} satisfies AletheiaDocumentSearchResult;

test("V1 document adapter preserves parsed and needs_ocr document records", () => {
  const documents = v1DocumentRecords(detail);

  assert.equal(documents.length, 2);
  assert.equal(documents[0].status, "parsed");
  assert.equal(documents[0].document_type, "contract");
  assert.equal(documents[0].mime_type, "application/pdf");
  assert.equal(documents[0].byte_size, 4096);
  assert.equal(documents[0].page_count, 12);
  assert.equal(documents[1].status, "needs_ocr");
  assert.equal(documents[1].parser, "ocr");
  assert.equal(documents[1].parse_error, "pdf_without_text_layer");
  assert.equal(documents[1].metadata?.needsOcr, true);

  for (const document of documents) {
    assert.equal(validateV1ArtifactShape("document_record", document).ok, true);
  }
});

test("V1 retrieval adapter maps search result into chunk and retrieval contracts", () => {
  const chunk = v1DocumentChunkFromSearchResult(searchResult);
  const retrieval = v1RetrievalResultFromSearchResult(searchResult);

  assert.equal(chunk.id, "chunk-notice");
  assert.equal(chunk.page, 12);
  assert.equal(chunk.start_offset, 1200);
  assert.equal(chunk.end_offset, 1281);
  assert.equal(retrieval.method, "keyword");
  assert.equal(retrieval.ranking_basis, "SQLite FTS5 BM25 keyword match");
  assert.equal(retrieval.quote_preview, searchResult.quote_preview);

  assert.equal(validateV1ArtifactShape("document_chunk", chunk).ok, true);
  assert.equal(validateV1ArtifactShape("retrieval_result", retrieval).ok, true);
});

test("V1 evidence source resolver maps evidence back to source chunk text and anchors", () => {
  const chunks = v1EvidenceSourceChunks(detail);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "chunk-notice");
  assert.equal(chunks[0].document_id, "matter-doc-text");
  assert.equal(chunks[0].page, 12);
  assert.equal(chunks[0].section, "8.2 Security Incident Notice");
  assert.equal(chunks[0].start_offset, 1200);
  assert.equal(chunks[0].end_offset, 1281);
  assert.match(chunks[0].text, /48 hours/);
  assert.equal(chunks[0].metadata?.evidence_item_id, "evidence-notice");

  assert.equal(validateV1ArtifactShape("document_chunk", chunks[0]).ok, true);
});
