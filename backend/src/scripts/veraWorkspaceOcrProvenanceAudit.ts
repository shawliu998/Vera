import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION,
  chunkMatterDocument,
  normalizeMatterDocumentText,
  type MatterDocumentPdfPageSpan,
  type ParsedDocumentChunk,
  type MatterDocumentExtraction,
} from "../lib/aletheia/documentParser";
import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  MAX_DOCUMENT_CHUNK_METADATA_BYTES,
  type DocumentChunkMetadata,
  type DocumentChunkOcrMetadata,
} from "../lib/workspace/documentChunkMetadata";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WORKSPACE_MIGRATIONS } from "../lib/workspace/migrations";
import { WorkspaceBlobCleanupRepository } from "../lib/workspace/repositories/blobCleanup";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceDocumentsRepository } from "../lib/workspace/repositories/documents";
import { hasUnpairedSurrogateV1 } from "../lib/workspace/workspacePersistencePrimitivesV1";
import {
  WorkspaceDocumentParser,
  documentExtractionChunks,
} from "../lib/workspace/documentParsing";
import { WorkspaceDocumentsService } from "../lib/workspace/services/documents";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(args.plaintext);
  }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(args.envelope);
  }
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function pageFixture(
  token: string,
  count: number,
  confidence: number,
  sensitiveFirstBlock = false,
) {
  const parts = Array.from(
    { length: count },
    (_, index) =>
      `${token} ${index} ${
        index === 0 && sensitiveFirstBlock
          ? "/Users/alice/private.pdf Bearer password=local-secret "
          : ""
      }${"x".repeat(118)}`,
  );
  let offset = 0;
  const blocks = parts.map((text, index) => {
    const textStart = offset;
    const textEnd = textStart + text.length;
    offset = textEnd + 1;
    return {
      textStart,
      textEnd,
      confidence,
      boundingBox: {
        x: 0.05,
        y: (index % 10) * 0.09,
        width: 0.9,
        height: 0.05,
      },
    };
  });
  return { text: parts.join("\n"), blocks };
}

function pdfFixture(
  pages: readonly Readonly<{ page: number; text: string }>[],
) {
  let text = "";
  const partial: Array<Omit<MatterDocumentPdfPageSpan, "textEnd">> = [];
  for (const entry of pages) {
    if (text) text += "\n\n";
    const textStart = text.length;
    text += `[Page ${entry.page}]\n`;
    const contentStart = text.length;
    text += entry.text;
    partial.push({
      page: entry.page,
      textStart,
      contentStart,
      contentEnd: text.length,
    });
  }
  return {
    text,
    pageSpanSchemaVersion: MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION,
    pageSpans: partial.map((span, index) => ({
      ...span,
      textEnd: partial[index + 1]?.textStart ?? text.length,
    })),
  };
}

function ocr(value: DocumentChunkMetadata): DocumentChunkOcrMetadata | null {
  return "schemaVersion" in value ? value : null;
}

function assertLosslessChunkCoverage(
  source: string,
  chunks: ParsedDocumentChunk[],
) {
  const normalized = normalizeMatterDocumentText(source);
  assert.ok(chunks.length > 1, "fixture must exercise multiple chunks");
  let coveredEnd = 0;
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.chunkIndex, index);
    assert.ok(chunk.quoteEnd > chunk.quoteStart, "chunks must make progress");
    if (index > 0) {
      assert.ok(
        chunk.quoteStart > (chunks[index - 1]?.quoteStart ?? -1),
        "overlapping chunk starts must still advance",
      );
    }
    assert.ok(
      chunk.quoteStart <= coveredEnd,
      "overlapping chunks must not leave a source-text gap",
    );
    assert.equal(
      normalized.slice(chunk.quoteStart, chunk.quoteEnd),
      chunk.text,
      "a chunk quote anchor must reproduce its exact normalized source text",
    );
    assert.equal(chunk.quoteEnd - chunk.quoteStart, chunk.text.length);
    assert.equal(hasUnpairedSurrogateV1(chunk.text), false);
    coveredEnd = Math.max(coveredEnd, chunk.quoteEnd);
  });
  assert.equal(chunks[0]?.quoteStart, 0);
  assert.equal(coveredEnd, normalized.length);
}

function rows(database: WorkspaceDatabase, documentId: string) {
  return database
    .prepare(
      `SELECT id, ordinal, text, start_offset, end_offset, page_start,
              page_end, metadata_json
         FROM document_chunks WHERE document_id = ? ORDER BY ordinal`,
    )
    .all(documentId);
}

function oversizedMetadata(): DocumentChunkMetadata {
  const metadata = {
    schemaVersion: "vera-document-chunk-ocr-v1",
    engine: "apple-vision",
    coordinateSpace: "normalized-top-left",
    page: 1,
    chunkPageTextStart: 0,
    pageConfidence: 0.12345678901234568,
    lowConfidence: true,
    blocks: Array.from({ length: 768 }, (_, index) => ({
      textStart: index * 2,
      textEnd: index * 2 + 1,
      confidence: 0.12345678901234568,
      boundingBox: {
        x: 0.1111111111111111,
        y: 0.2222222222222222,
        width: 0.3333333333333333,
        height: 0.4444444444444444,
      },
    })),
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(metadata)) >
      MAX_DOCUMENT_CHUNK_METADATA_BYTES,
  );
  return metadata as unknown as DocumentChunkMetadata;
}

function auditV1Upgrade(root: string) {
  assert.equal(WORKSPACE_MIGRATIONS[0]?.version, 1);
  assert.equal(WORKSPACE_MIGRATIONS.at(-1)?.version, 16);
  const file = path.join(root, "v1.sqlite");
  const projectId = randomUUID();
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const text = "legacyfixtureword remains readable";
  const v1 = new WorkspaceDatabase(file, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 1),
  });
  v1.prepare("INSERT INTO projects (id,name) VALUES (?,'Legacy')").run(
    projectId,
  );
  v1.prepare(
    `INSERT INTO documents
       (id,project_id,title,filename,mime_type,size_bytes,parse_status)
     VALUES (?,?,'Legacy','legacy.txt','text/plain',?,'ready')`,
  ).run(documentId, projectId, Buffer.byteLength(text));
  v1.prepare(
    `INSERT INTO document_versions
       (id,document_id,version_number,source,filename,mime_type,size_bytes,
        content_sha256,storage_key)
     VALUES (?,?,1,'upload','legacy.txt','text/plain',?,?,?)`,
  ).run(
    versionId,
    documentId,
    Buffer.byteLength(text),
    sha256(text),
    `documents/${documentId}/versions/${versionId}/original`,
  );
  v1.prepare("UPDATE documents SET current_version_id=? WHERE id=?").run(
    versionId,
    documentId,
  );
  v1.prepare(
    `INSERT INTO document_chunks
       (id,document_id,version_id,ordinal,text,start_offset,end_offset,content_sha256)
     VALUES (?,?,?,0,?,0,?,?)`,
  ).run(chunkId, documentId, versionId, text, text.length, sha256(text));
  assert.equal(
    v1
      .prepare("SELECT metadata_json FROM document_chunks WHERE id=?")
      .get(chunkId)?.metadata_json,
    "{}",
  );
  v1.close();
  const upgraded = new WorkspaceDatabase(file);
  try {
    const found = new WorkspaceDocumentsRepository(upgraded).searchChunks(
      "legacyfixtureword",
      { documentId },
    );
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.metadata, {});
  } finally {
    upgraded.close();
  }
}

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-ocr-provenance-"));
  const databasePath = path.join(root, "workspace.sqlite");
  let database: WorkspaceDatabase | null = null;
  try {
    auditV1Upgrade(root);
    const whitespaceChunks = chunkMatterDocument(
      `[Page 1]\na ${"word ".repeat(800)}\n\n`,
    );
    assert.ok(whitespaceChunks.length > 1);
    assert.ok(
      whitespaceChunks.every(
        (chunk) => chunk.quoteEnd - chunk.quoteStart === chunk.text.length,
      ),
      "leading and trailing trim must preserve exact UTF-16 chunk bounds",
    );
    for (const emojiStart of [1_199, 1_200, 1_039]) {
      const emojiSource = `${"a".repeat(emojiStart)}😀${"b".repeat(1_500)}`;
      const emojiChunks = chunkMatterDocument(emojiSource);
      assert.ok(emojiChunks.some((chunk) => chunk.text.includes("😀")));
      assertLosslessChunkCoverage(emojiSource, emojiChunks);
    }
    database = new WorkspaceDatabase(databasePath);
    const projectId = randomUUID();
    database
      .prepare("INSERT INTO projects (id,name) VALUES (?,'OCR')")
      .run(projectId);
    const blobs = new LocalWorkspaceBlobStore({
      root: path.join(root, "blobs"),
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    let cleanup = new WorkspaceBlobCleanupRepository(database);
    const recorder = {
      record(input: Parameters<WorkspaceBlobCleanupRepository["record"]>[0]) {
        cleanup.record(input);
      },
    };
    let blobRecords = new WorkspaceBlobRecordsRepository(database);
    let repository = new WorkspaceDocumentsRepository(database, {
      blobRecords,
    });
    let service = new WorkspaceDocumentsService(
      repository,
      blobs,
      randomUUID,
      recorder,
    );

    const low = pageFixture("ocrword", 16, 0.31, true);
    const high = pageFixture("highocrword", 4, 0.94);
    const lowText = `${low.text}\n[Page 77]\nocrmarkerword stays on OCR page two`;
    const textLayer =
      "textlayerword contract clause with inline [Page 98] literal\r\n" +
      "[Page 99]\r\nliteralmarkerword remains on real page one";
    const serializedPdf = pdfFixture([
      { page: 1, text: textLayer },
      { page: 2, text: lowText },
      { page: 3, text: high.text },
    ]);
    const extraction: MatterDocumentExtraction = {
      text: serializedPdf.text,
      metadata: {
        parser: "pdf+apple-vision",
        pageCount: 3,
        pageSpanSchemaVersion: serializedPdf.pageSpanSchemaVersion,
        pageSpans: serializedPdf.pageSpans,
        textLayerPageCount: 1,
        ocrPageCount: 2,
        ocrEngine: "apple-vision",
        ocrCoordinateSpace: "normalized-top-left",
        ocrPages: [
          { page: 2, confidence: 0.31, blocks: low.blocks },
          { page: 3, confidence: 0.94, blocks: high.blocks },
        ],
        lowConfidenceOcrPageCount: 1,
        lowConfidenceOcrPages: [{ page: 2, confidence: 0.31 }],
        unresolvedPageCount: 0,
        unresolvedPages: [],
      },
    };
    const assertInvalidExtraction = (
      mutate: (value: MatterDocumentExtraction) => void,
    ) => {
      const malformed = structuredClone(extraction);
      mutate(malformed);
      assert.throws(
        () => documentExtractionChunks(randomUUID(), malformed),
        /page span metadata is invalid|OCR extraction metadata is invalid/,
      );
    };
    assertInvalidExtraction((value) => {
      value.metadata.pageSpans?.pop();
    });
    assertInvalidExtraction((value) => {
      delete value.metadata.pageSpans;
    });
    assertInvalidExtraction((value) => {
      const spans = value.metadata.pageSpans;
      assert.ok(spans);
      const first = spans[0];
      const second = spans[1];
      assert.ok(first && second);
      spans[0] = second;
      spans[1] = first;
    });
    assertInvalidExtraction((value) => {
      const span = value.metadata.pageSpans?.[1] as
        | (MatterDocumentPdfPageSpan & { page: number })
        | undefined;
      assert.ok(span);
      span.page = 1;
    });
    assertInvalidExtraction((value) => {
      const span = value.metadata.pageSpans?.[0] as
        | (MatterDocumentPdfPageSpan & { contentEnd: number })
        | undefined;
      assert.ok(span);
      span.contentEnd += 1;
    });
    assertInvalidExtraction((value) => {
      const span = value.metadata.pageSpans?.[2] as
        | (MatterDocumentPdfPageSpan & { page: number })
        | undefined;
      assert.ok(span);
      span.page = 4;
    });
    assertInvalidExtraction((value) => {
      delete value.metadata.ocrPages;
    });
    const original = Buffer.from("%PDF-1.4\noriginal bytes stay unchanged\n");
    const uploaded = await service.upload({
      filename: "mixed.pdf",
      mimetype: "application/pdf",
      buffer: original,
      projectId,
    });
    const parser = new WorkspaceDocumentParser(
      repository,
      blobs,
      async () => extraction,
      randomUUID,
      recorder,
    );
    assert.equal(
      (
        await parser.process({
          documentId: uploaded.document.id,
          versionId: uploaded.version.id,
          jobId: uploaded.job.id,
        })
      ).status,
      "ready",
    );
    assert.deepEqual(
      blobs.readSync(
        {
          kind: "original",
          documentId: uploaded.document.id,
          versionId: uploaded.version.id,
        },
        { sha256: sha256(original), size: original.length },
      ),
      original,
    );
    assert.deepEqual(
      repository.searchChunks("textlayerword", {
        documentId: uploaded.document.id,
      })[0]?.metadata,
      {},
    );
    const literalMarkerChunks = repository.searchChunks("literalmarkerword", {
      documentId: uploaded.document.id,
    });
    assert.equal(literalMarkerChunks.length, 1);
    assert.equal(literalMarkerChunks[0]?.pageStart, 1);
    assert.equal(literalMarkerChunks[0]?.pageEnd, 1);
    assert.match(literalMarkerChunks[0]?.text ?? "", /\[Page 99\]/);
    assert.doesNotMatch(literalMarkerChunks[0]?.text ?? "", /\r/);
    assert.equal(
      repository.searchChunks("literalmarkerword", {
        documentId: uploaded.document.id,
      })[0]?.pageStart,
      1,
      "a literal line-start page marker must not forge Workspace pagination",
    );
    for (const row of rows(database, uploaded.document.id)) {
      assert.equal(
        Number(row.end_offset) - Number(row.start_offset),
        String(row.text).length,
        "new chunks must persist exact UTF-16 text bounds after trimming",
      );
    }
    const lowChunks = repository.searchChunks("ocrword", {
      documentId: uploaded.document.id,
    });
    assert.ok(lowChunks.length >= 2);
    const lowMetadata = lowChunks.map((chunk) => {
      const metadata = ocr(chunk.metadata);
      assert.ok(metadata);
      assert.equal(metadata.page, 2);
      assert.equal(metadata.lowConfidence, true);
      assert.ok(metadata.blocks.length < low.blocks.length);
      const serialized = JSON.stringify(metadata);
      assert.doesNotMatch(serialized, /"text"\s*:/i);
      assert.doesNotMatch(serialized, /\/Users\//);
      assert.doesNotMatch(serialized, /Bearer|password=/i);
      const pageEnd = metadata.chunkPageTextStart + chunk.text.length;
      assert.ok(
        metadata.blocks.every(
          (block) =>
            block.textEnd > metadata.chunkPageTextStart &&
            block.textStart < pageEnd,
        ),
      );
      return metadata;
    });
    assert.ok(lowMetadata.some((metadata) => metadata.chunkPageTextStart < 0));
    assert.ok(lowMetadata.some((metadata) => metadata.chunkPageTextStart > 0));
    const ocrLiteralChunks = repository.searchChunks("ocrmarkerword", {
      documentId: uploaded.document.id,
    });
    assert.equal(ocrLiteralChunks.length, 1);
    assert.equal(ocrLiteralChunks[0]?.pageStart, 2);
    assert.equal(ocr(ocrLiteralChunks[0]!.metadata)?.page, 2);
    const blockCounts = new Map<string, number>();
    for (const metadata of lowMetadata) {
      for (const block of metadata.blocks) {
        const key = `${block.textStart}:${block.textEnd}`;
        blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1);
      }
    }
    assert.ok([...blockCounts.values()].some((count) => count > 1));
    assert.ok(
      repository
        .searchChunks("highocrword", { documentId: uploaded.document.id })
        .every((chunk) => ocr(chunk.metadata)?.lowConfidence === false),
    );

    const noOcr = await service.upload({
      filename: "layer.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nlayer\n"),
      projectId,
    });
    const noOcrParser = new WorkspaceDocumentParser(
      repository,
      blobs,
      async () => {
        const serialized = pdfFixture([
          { page: 1, text: "plainpdfword text layer" },
        ]);
        return {
          text: serialized.text,
          metadata: {
            parser: "pdf" as const,
            pageCount: 1,
            pageSpanSchemaVersion: serialized.pageSpanSchemaVersion,
            pageSpans: serialized.pageSpans,
            textLayerPageCount: 1,
            ocrPageCount: 0,
            unresolvedPageCount: 0,
            unresolvedPages: [],
          },
        };
      },
      randomUUID,
      recorder,
    );
    assert.equal(
      (
        await noOcrParser.process({
          documentId: noOcr.document.id,
          versionId: noOcr.version.id,
          jobId: noOcr.job.id,
        })
      ).status,
      "ready",
    );
    assert.deepEqual(
      repository.searchChunks("plainpdfword", {
        documentId: noOcr.document.id,
      })[0]?.metadata,
      {},
    );

    const before = rows(database, noOcr.document.id);
    assert.throws(
      () =>
        repository.replaceChunks(noOcr.document.id, noOcr.version.id, [
          {
            ordinal: 0,
            text: "x".repeat(2_000),
            startOffset: 0,
            endOffset: 2_000,
            pageStart: 1,
            pageEnd: 1,
            metadata: oversizedMetadata(),
          },
        ]),
      /chunk metadata is invalid/,
    );
    assert.deepEqual(rows(database, noOcr.document.id), before);
    const noOcrChunkId = String(before[0]?.id);
    database
      .prepare("UPDATE document_chunks SET metadata_json=? WHERE id=?")
      .run(
        JSON.stringify({
          padding: "x".repeat(MAX_DOCUMENT_CHUNK_METADATA_BYTES),
        }),
        noOcrChunkId,
      );
    assert.throws(
      () =>
        repository.searchChunks("plainpdfword", {
          documentId: noOcr.document.id,
        }),
      /chunk metadata is invalid/,
    );
    database
      .prepare("UPDATE document_chunks SET metadata_json='{}' WHERE id=?")
      .run(noOcrChunkId);

    const persisted = lowChunks.map((chunk) => chunk.metadata);
    database.close();
    database = new WorkspaceDatabase(databasePath);
    cleanup = new WorkspaceBlobCleanupRepository(database);
    blobRecords = new WorkspaceBlobRecordsRepository(database);
    repository = new WorkspaceDocumentsRepository(database, { blobRecords });
    service = new WorkspaceDocumentsService(
      repository,
      blobs,
      randomUUID,
      recorder,
    );
    assert.deepEqual(
      repository
        .searchChunks("ocrword", { documentId: uploaded.document.id })
        .map((chunk) => chunk.metadata),
      persisted,
    );

    const malicious = structuredClone(extraction) as MatterDocumentExtraction;
    const badBlock = malicious.metadata.ocrPages?.[0]?.blocks?.[0] as
      | { textEnd: number }
      | undefined;
    assert.ok(badBlock);
    badBlock.textEnd = low.text.length + 10_000;
    const badUpload = await service.upload({
      filename: "bad.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nbad\n"),
      projectId,
    });
    const badParser = new WorkspaceDocumentParser(
      repository,
      blobs,
      async () => malicious,
      randomUUID,
      recorder,
    );
    assert.equal(
      (
        await badParser.process({
          documentId: badUpload.document.id,
          versionId: badUpload.version.id,
          jobId: badUpload.job.id,
        })
      ).status,
      "failed",
    );
    assert.equal(
      repository.searchChunks("ocrword", { documentId: badUpload.document.id })
        .length,
      0,
    );

    console.log(
      JSON.stringify({
        ok: true,
        mixedPdf: true,
        lowConfidence: true,
        overlapMapping: true,
        noOcrMetadata: {},
        restartReadable: true,
        v1ToV12Readable: true,
        metadataByteLimit: MAX_DOCUMENT_CHUNK_METADATA_BYTES,
        invalidCrossPageRejected: true,
        structuredPdfPageSpans: true,
        literalPageMarkersCannotForgePagination: true,
        malformedPageSpansRejected: true,
        ocrChunksRequireProvenance: true,
        crlfSpanNormalization: true,
        utf16SurrogateBoundaries: true,
        losslessMultiChunkQuoteCoverage: true,
      }),
    );
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
