import "dotenv/config";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function responseJson(response: Response) {
  const body = await response.json();
  return { status: response.status, body: body as any };
}

function metadataForRow(row: any) {
  return JSON.parse(String(row.metadata)) as Record<string, any>;
}

async function main() {
  const auditDataDir = path.join(
    os.tmpdir(),
    `aletheia-document-parse-retry-${Date.now()}`,
  );
  rmSync(auditDataDir, { recursive: true, force: true });
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = auditDataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "document-retry-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "document-retry@aletheia.internal";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const [{ createAletheiaRepository }, { LocalDatabase }, { aletheiaRouter }] =
    await Promise.all([
      import("../lib/aletheia"),
      import("../lib/aletheia/localDatabase"),
      import("../routes/aletheia"),
    ]);

  const ctx = {
    userId: "document-retry-user",
    userEmail: "document-retry@aletheia.internal",
  };
  const repo = createAletheiaRepository();
  const matter: any = await repo.createMatter(ctx, {
    title: "Document Parse Retry Audit",
    objective: "Verify durable parse retry behavior and isolation.",
    template: "legal_matter_review",
    status: "draft",
    riskLevel: "medium",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { audit: "document_parse_retry" },
  });
  const otherMatter: any = await repo.createMatter(ctx, {
    title: "Other Matter",
    objective: "Verify matter-scoped document access.",
    template: "legal_matter_review",
    status: "draft",
    riskLevel: "low",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { audit: "document_parse_retry_isolation" },
  });

  const db = new LocalDatabase(path.join(auditDataDir, "aletheia.db"));
  const app = express();
  app.use("/aletheia", aletheiaRouter);
  const server = app.listen(0);

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object", "Server should listen");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const retryUrl = (targetMatterId: string, documentId: string) =>
      `${baseUrl}/aletheia/matters/${targetMatterId}/documents/${documentId}/retry-parse`;

    const parsedConflict: any = await repo.uploadMatterDocument(
      ctx,
      matter.id,
      {
        filename: "already-parsed.txt",
        mimeType: "text/plain",
        sizeBytes: 36,
        buffer: Buffer.from("This document has already been parsed."),
      },
    );
    const parsedResponse = await responseJson(
      await fetch(retryUrl(matter.id, parsedConflict.id), { method: "POST" }),
    );
    assert(parsedResponse.status === 409, "Parsed retry should return 409");
    assert(
      parsedResponse.body.code === "document_not_retryable",
      "Parsed retry should return document_not_retryable",
    );

    const ocrConflict: any = await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "requires-ocr.txt",
      mimeType: "text/plain",
      sizeBytes: 27,
      buffer: Buffer.from("Status is forced to OCR."),
    });
    db.prepare(
      `update aletheia_matter_documents
       set parsed_status = 'needs_ocr' where id = ? and matter_id = ? and user_id = ?`,
    ).run(ocrConflict.id, matter.id, ctx.userId);
    const ocrResponse = await responseJson(
      await fetch(retryUrl(matter.id, ocrConflict.id), { method: "POST" }),
    );
    assert(ocrResponse.status === 409, "OCR retry should return 409");
    assert(
      ocrResponse.body.code === "ocr_required",
      "OCR retry should return ocr_required",
    );
    assert(
      ocrResponse.body.document.metadata.parseAttemptCount === undefined,
      "Rejected OCR retry should not increment attempt count",
    );

    const successful: any = await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "retry-success.txt",
      mimeType: "text/plain",
      sizeBytes: 69,
      buffer: Buffer.from(
        "Durable parse retry restores the distinctive zephyr deadline clause.",
      ),
    });
    const staleChunkId = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "delete from aletheia_document_chunks_fts where matter_id = ? and document_id = ?",
      ).run(matter.id, successful.id);
      db.prepare(
        "delete from aletheia_document_chunks where matter_id = ? and document_id = ? and user_id = ?",
      ).run(matter.id, successful.id, ctx.userId);
      db.prepare(
        `insert into aletheia_document_chunks (
           id, matter_id, document_id, user_id, chunk_index, page, section,
           text, quote_start, quote_end, metadata, created_at
         ) values (?, ?, ?, ?, 0, null, null, ?, 0, ?, '{}', ?)`,
      ).run(
        staleChunkId,
        matter.id,
        successful.id,
        ctx.userId,
        "stale chunk that must be replaced",
        32,
        new Date().toISOString(),
      );
      db.prepare(
        `insert into aletheia_document_chunks_fts (
           chunk_id, matter_id, document_id, document_name, text
         ) values (?, ?, ?, ?, ?)`,
      ).run(
        staleChunkId,
        matter.id,
        successful.id,
        successful.name,
        "stale chunk that must be replaced",
      );
      db.prepare(
        `update aletheia_matter_documents
         set parsed_status = 'failed' where id = ? and matter_id = ? and user_id = ?`,
      ).run(successful.id, matter.id, ctx.userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const crossMatterResponse = await responseJson(
      await fetch(retryUrl(otherMatter.id, successful.id), { method: "POST" }),
    );
    assert(
      crossMatterResponse.status === 404,
      "Cross-matter retry should return 404",
    );
    let foreignUserError: any = null;
    try {
      await repo.retryMatterDocumentParse(
        {
          userId: "another-user",
          userEmail: "another-user@aletheia.internal",
        },
        matter.id,
        successful.id,
      );
    } catch (error) {
      foreignUserError = error;
    }
    assert(
      foreignUserError?.code === "FORBIDDEN" &&
        foreignUserError?.status === 403,
      "Cross-user retry should be forbidden",
    );

    const successResponse = await responseJson(
      await fetch(retryUrl(matter.id, successful.id), { method: "POST" }),
    );
    assert(successResponse.status === 200, "Failed parse retry should succeed");
    assert(
      successResponse.body.parsed_status === "parsed",
      "Successful retry should set parsed status",
    );
    assert(
      successResponse.body.metadata.parseAttemptCount === 1,
      "Successful retry should persist attempt count",
    );
    assert(
      successResponse.body.metadata.lastParseError === null &&
        typeof successResponse.body.metadata.lastParseStartedAt === "string" &&
        typeof successResponse.body.metadata.lastParseCompletedAt === "string",
      "Successful retry should persist parse timing and clear the error",
    );
    const rebuiltChunks = db
      .prepare(
        `select id, text from aletheia_document_chunks
         where matter_id = ? and document_id = ? order by chunk_index`,
      )
      .all(matter.id, successful.id) as any[];
    assert(rebuiltChunks.length > 0, "Successful retry should create chunks");
    assert(
      rebuiltChunks.every((chunk) => chunk.id !== staleChunkId) &&
        rebuiltChunks.some((chunk) => chunk.text.includes("zephyr deadline")),
      "Successful retry should replace stale chunks with parsed source text",
    );
    const rebuiltFts = db
      .prepare(
        `select text from aletheia_document_chunks_fts
         where matter_id = ? and document_id = ?`,
      )
      .all(matter.id, successful.id) as any[];
    assert(
      rebuiltFts.some((chunk) => chunk.text.includes("zephyr deadline")) &&
        rebuiltFts.every((chunk) => !chunk.text.includes("stale chunk")),
      "Successful retry should replace FTS rows in the same transaction",
    );

    const failedParse: any = await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "broken.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 18,
      buffer: Buffer.from("not-a-valid-docx"),
    });
    assert(
      failedParse.parsed_status === "failed",
      "Invalid DOCX fixture should begin in failed state",
    );
    const preservedChunkId = randomUUID();
    db.prepare(
      `insert into aletheia_document_chunks (
         id, matter_id, document_id, user_id, chunk_index, page, section,
         text, quote_start, quote_end, metadata, created_at
       ) values (?, ?, ?, ?, 0, null, null, ?, 0, ?, '{}', ?)`,
    ).run(
      preservedChunkId,
      matter.id,
      failedParse.id,
      ctx.userId,
      "preserve this prior chunk on parser failure",
      43,
      new Date().toISOString(),
    );
    db.prepare(
      `insert into aletheia_document_chunks_fts (
         chunk_id, matter_id, document_id, document_name, text
       ) values (?, ?, ?, ?, ?)`,
    ).run(
      preservedChunkId,
      matter.id,
      failedParse.id,
      failedParse.name,
      "preserve this prior chunk on parser failure",
    );
    const failureResponse = await responseJson(
      await fetch(retryUrl(matter.id, failedParse.id), { method: "POST" }),
    );
    assert(failureResponse.status === 422, "Parser failure should return 422");
    assert(
      failureResponse.body.code === "document_parse_retry_failed",
      "Parser failure should return document_parse_retry_failed",
    );
    const failedRow: any = db
      .prepare("select * from aletheia_matter_documents where id = ?")
      .get(failedParse.id);
    const failedMetadata = metadataForRow(failedRow);
    assert(
      failedMetadata.parseAttemptCount === 1 &&
        typeof failedMetadata.lastParseError === "string" &&
        failedMetadata.lastParseError.length > 0,
      "Parser failure should persist attempt and error metadata",
    );
    assert(
      db
        .prepare("select id from aletheia_document_chunks where id = ?")
        .get(preservedChunkId) &&
        db
          .prepare(
            "select chunk_id from aletheia_document_chunks_fts where chunk_id = ?",
          )
          .get(preservedChunkId),
      "Parser failure should preserve prior chunks and FTS rows",
    );

    const tampered: any = await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "tampered-source.txt",
      mimeType: "text/plain",
      sizeBytes: 45,
      buffer: Buffer.from("Original source must remain hash authoritative."),
    });
    db.prepare(
      `update aletheia_matter_documents
       set parsed_status = 'failed' where id = ? and matter_id = ? and user_id = ?`,
    ).run(tampered.id, matter.id, ctx.userId);
    const tamperedBefore = db
      .prepare(
        "select id, text from aletheia_document_chunks where document_id = ? order by chunk_index",
      )
      .all(tampered.id) as any[];
    chmodSync(tampered.metadata.storagePath, 0o600);
    writeFileSync(tampered.metadata.storagePath, "tampered bytes", {
      mode: 0o600,
    });
    const tamperedResponse = await responseJson(
      await fetch(retryUrl(matter.id, tampered.id), { method: "POST" }),
    );
    assert(tamperedResponse.status === 409, "Hash mismatch should return 409");
    assert(
      tamperedResponse.body.code === "document_source_integrity_failed",
      "Hash mismatch should fail closed with integrity code",
    );
    const tamperedRow: any = db
      .prepare("select * from aletheia_matter_documents where id = ?")
      .get(tampered.id);
    const tamperedMetadata = metadataForRow(tamperedRow);
    assert(
      tamperedMetadata.parseAttemptCount === 1 &&
        tamperedMetadata.lastParseError.includes("originalSha256"),
      "Hash mismatch should persist attempt and error metadata",
    );
    const tamperedAfter = db
      .prepare(
        "select id, text from aletheia_document_chunks where document_id = ? order by chunk_index",
      )
      .all(tampered.id) as any[];
    assert(
      JSON.stringify(tamperedAfter) === JSON.stringify(tamperedBefore),
      "Hash mismatch should preserve prior chunks",
    );

    const detail: any = await repo.getMatterDetail(ctx, matter.id);
    const successAudits = detail.auditEvents.filter(
      (event: any) =>
        event.action === "document_parse_retry_succeeded" &&
        event.details.documentId === successful.id,
    );
    const failureAudits = detail.auditEvents.filter(
      (event: any) => event.action === "document_parse_retry_failed",
    );
    assert(successAudits.length === 1, "Success retry audit should be durable");
    assert(
      failureAudits.some(
        (event: any) =>
          event.details.documentId === failedParse.id &&
          event.details.code === "document_parse_retry_failed",
      ),
      "Parser failure audit should be durable",
    );
    assert(
      failureAudits.some(
        (event: any) =>
          event.details.documentId === tampered.id &&
          event.details.code === "document_source_integrity_failed",
      ),
      "Integrity failure audit should be durable",
    );

    process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
    process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
    process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString(
      "base64",
    );
    const encrypted: any = await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "encrypted-retry.txt",
      mimeType: "text/plain",
      sizeBytes: 58,
      buffer: Buffer.from(
        "Encrypted authoritative source supports parse retry persistence.",
      ),
    });
    assert(
      !readFileSync(encrypted.metadata.storagePath).includes(
        Buffer.from("Encrypted authoritative source"),
      ),
      "Encrypted fixture should not persist plaintext source bytes",
    );
    db.prepare(
      `update aletheia_matter_documents
       set parsed_status = 'failed' where id = ? and matter_id = ? and user_id = ?`,
    ).run(encrypted.id, matter.id, ctx.userId);
    const encryptedResponse = await responseJson(
      await fetch(retryUrl(matter.id, encrypted.id), { method: "POST" }),
    );
    assert(
      encryptedResponse.status === 200 &&
        encryptedResponse.body.parsed_status === "parsed" &&
        encryptedResponse.body.metadata.parseAttemptCount === 1,
      "Encrypted source retry should decrypt, verify, parse, and persist",
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          route:
            "/aletheia/matters/:matterId/documents/:documentId/retry-parse",
          parsedConflict: parsedResponse.status,
          ocrConflict: ocrResponse.status,
          crossMatter: crossMatterResponse.status,
          successfulRetry: {
            status: successResponse.status,
            chunks: rebuiltChunks.length,
            auditEvents: successAudits.length,
          },
          failedRetry: {
            status: failureResponse.status,
            chunksPreserved: true,
          },
          integrityFailure: {
            status: tamperedResponse.status,
            chunksPreserved: true,
          },
          encryptedSourceRetry: encryptedResponse.status,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeServer(server);
    db.close();
    rmSync(auditDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
