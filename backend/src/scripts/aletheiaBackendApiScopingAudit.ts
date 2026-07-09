import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAletheiaRepository } from "@/lib/aletheia";

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "aletheia-v1-source-"));
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";

  try {
    const repo = createAletheiaRepository();
    const ctx = {
      userId: "backend-api-scope-user",
      userEmail: "backend-api-scope@example.test",
    };
    const matter = (await repo.createMatter(ctx, {
      title: "Backend API Source Index Matter",
      objective:
        "Verify V1 source index listing for export/audit and eval consumers.",
      template: "legal_matter_review",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "V1 backend scoping",
      sourceProjectId: null,
      sharedWith: [],
      metadata: { suite: "aletheia-backend-api-scoping-v0" },
    })) as { id: string };

    const document = (await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "security-incident-notice.txt",
      mimeType: "text/plain",
      sizeBytes: 122,
      buffer: Buffer.from(
        "Vendor must notify Customer of a confirmed security incident no later than 48 hours after confirmation.",
        "utf8",
      ),
    })) as { id: string; parsed_status: string };
    assert.equal(document.parsed_status, "parsed");

    const searchResults = (await repo.searchMatterDocuments(ctx, matter.id, {
      query: "security",
      limit: 1,
    })) as Array<{ chunk_id: string }>;
    assert.equal(searchResults.length, 1);

    const evidence = (await repo.createEvidenceItem(ctx, matter.id, {
      sourceChunkId: searchResults[0].chunk_id,
      relevance: "direct",
      supportStatus: "supports",
      confidence: "high",
    })) as { id: string; source_chunk_id: string };
    assert.equal(evidence.source_chunk_id, searchResults[0].chunk_id);

    const index = (await repo.listV1SourceIndex(ctx, matter.id, {
      includeChunks: true,
      includeEvidenceLinks: true,
      chunkLimit: 20,
    })) as {
      schema_version: string;
      storage_driver: string;
      documents: Array<{
        id: string;
        matter_id: string;
        status: string;
        uploaded_at: string;
      }>;
      chunks: Array<{
        id: string;
        matter_id: string;
        document_id: string;
        text: string;
        start_offset: number;
        end_offset: number;
      }>;
      source_links: Array<{
        evidence_item_id: string;
        document_id: string;
        source_chunk_id: string;
      }>;
      limitations: string[];
    };

    assert.equal(index.schema_version, "aletheia-v1-source-index-local-v0");
    assert.equal(index.storage_driver, "local");
    assert.equal(index.documents.length, 1);
    assert.equal(index.documents[0].id, document.id);
    assert.equal(index.documents[0].matter_id, matter.id);
    assert.equal(index.documents[0].status, "parsed");
    assert.ok(index.documents[0].uploaded_at);
    assert.equal(index.chunks.length, 1);
    assert.equal(index.chunks[0].document_id, document.id);
    assert.match(index.chunks[0].text, /security incident/);
    assert.equal(index.chunks[0].start_offset, 0);
    assert.ok(index.chunks[0].end_offset > 0);
    assert.equal(index.source_links.length, 1);
    assert.equal(index.source_links[0].evidence_item_id, evidence.id);
    assert.equal(index.source_links[0].source_chunk_id, searchResults[0].chunk_id);
    assert.match(index.limitations.join(" "), /Supabase V1 document retrieval/);

    console.log(
      "Aletheia backend/API scoping audit passed: local V1 source index lists documents, chunks, and evidence source links.",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-backend-api-scoping-audit] failed", error);
  process.exitCode = 1;
});
