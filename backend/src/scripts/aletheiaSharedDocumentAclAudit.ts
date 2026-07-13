import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

type JsonBody = Record<string, any>;

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function jsonResponse(response: Response) {
  return {
    status: response.status,
    body: (await response.json()) as JsonBody,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function uploadForm(filename: string, content: string, type = "text/plain") {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), filename);
  return form;
}

function batchForm(filename: string, content: string) {
  const form = new FormData();
  form.append(
    "files",
    new Blob([content], { type: "application/octet-stream" }),
    filename,
  );
  return form;
}

function assertNoInternalDocumentPaths(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("storagePath"), false);
  assert.equal(serialized.includes("derivedStoragePath"), false);
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-shared-doc-acl-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN =
    "owner-bootstrap-token-for-shared-document-acl-audit";
  process.env.ALETHEIA_LOCAL_USER_ID = "shared-doc-owner";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "owner@local.invalid";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  process.env.ALETHEIA_MALWARE_SCAN_MODE = "disabled";
  process.env.ALETHEIA_CDR_MODE = "disabled";

  const [
    { LocalAletheiaRepository },
    { LocalDatabase },
    { LocalGovernanceService },
    { LocalIdentityRepository },
    { aletheiaRouter },
  ] = await Promise.all([
    import("../lib/aletheia/localRepository"),
    import("../lib/aletheia/localDatabase"),
    import("../lib/aletheia/localGovernance"),
    import("../lib/aletheia/localIdentity"),
    import("../routes/aletheia"),
  ]);

  const owner = {
    userId: "shared-doc-owner",
    userEmail: "owner@local.invalid",
  };
  const counselId = "shared-doc-counsel";
  const reviewerId = "shared-doc-reviewer";
  const repository = new LocalAletheiaRepository();
  const matterInput = {
    objective: "Verify shared document ACL ownership and actor attribution",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { audit: "shared_document_acl" },
  };
  const matter = (await repository.createMatter(owner, {
    ...matterInput,
    title: "Shared document ACL matter",
  })) as { id: string };
  const otherMatter = (await repository.createMatter(owner, {
    ...matterInput,
    title: "Shared document isolation matter",
  })) as { id: string };

  const databasePath = path.join(root, "aletheia.db");
  const governance = new LocalGovernanceService({
    databasePath,
    multiPrincipalEnabled: true,
  });
  governance.governance(owner.userId, matter.id);
  governance.governance(owner.userId, otherMatter.id);
  governance.createPrincipal(owner.userId, {
    id: counselId,
    displayName: "Shared Counsel",
    roles: ["counsel"],
  });
  governance.createPrincipal(owner.userId, {
    id: reviewerId,
    displayName: "Read-only Reviewer",
    roles: ["reviewer"],
  });
  governance.setMatterAcl(owner.userId, matter.id, counselId, "counsel");
  governance.setMatterAcl(owner.userId, otherMatter.id, counselId, "counsel");
  governance.setMatterAcl(owner.userId, matter.id, reviewerId, "reviewer");

  const identities = new LocalIdentityRepository({ databasePath });
  const counselToken = identities.issueToken({
    principalId: counselId,
    createdBy: owner.userId,
    email: "counsel@local.invalid",
  }).token;
  const reviewerToken = identities.issueToken({
    principalId: reviewerId,
    createdBy: owner.userId,
    email: "reviewer@local.invalid",
  }).token;
  const db = new LocalDatabase(databasePath);

  const app = express();
  app.use("/aletheia", aletheiaRouter);
  const server = app.listen(0);

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const uploadUrl = (matterId: string) =>
      `${baseUrl}/aletheia/matters/${matterId}/documents`;
    const batchUrl = (matterId: string) => `${uploadUrl(matterId)}/batch`;
    const retryUrl = (matterId: string, documentId: string) =>
      `${uploadUrl(matterId)}/${documentId}/retry-parse`;

    const counselUpload = await jsonResponse(
      await fetch(uploadUrl(matter.id), {
        method: "POST",
        headers: bearer(counselToken),
        body: uploadForm(
          "counsel-upload.txt",
          "Counsel uploaded evidence remains owned by the matter owner.",
        ),
      }),
    );
    assert.equal(counselUpload.status, 201);
    assert.equal(counselUpload.body.user_id, owner.userId);
    assertNoInternalDocumentPaths(counselUpload.body);
    const uploadedDocumentId = String(counselUpload.body.id);
    const uploadedRow = db
      .prepare(
        `select user_id, matter_id from aletheia_matter_documents where id = ?`,
      )
      .get(uploadedDocumentId) as { user_id: string; matter_id: string };
    assert.equal(uploadedRow.user_id, owner.userId);
    assert.equal(uploadedRow.matter_id, matter.id);
    const uploadedChunks = db
      .prepare(
        `select user_id from aletheia_document_chunks
         where matter_id = ? and document_id = ?`,
      )
      .all(matter.id, uploadedDocumentId) as Array<{ user_id: string }>;
    assert.ok(uploadedChunks.length > 0);
    assert.ok(uploadedChunks.every((row) => row.user_id === owner.userId));
    const uploadAudit = db
      .prepare(
        `select user_id, details from aletheia_audit_events
         where matter_id = ? and action = 'document_uploaded'
         order by created_at desc limit 1`,
      )
      .get(matter.id) as { user_id: string; details: string };
    const uploadDetails = JSON.parse(uploadAudit.details);
    assert.equal(uploadAudit.user_id, owner.userId);
    assert.equal(uploadDetails.actorId, counselId);
    assert.equal(uploadDetails.independentActor, true);

    const documentCount = () =>
      Number(
        (
          db
            .prepare(
              "select count(*) as count from aletheia_matter_documents where matter_id = ?",
            )
            .get(matter.id) as { count: number }
        ).count,
      );
    const beforeReadOnlyDenials = documentCount();
    const reviewerUpload = await jsonResponse(
      await fetch(uploadUrl(matter.id), {
        method: "POST",
        headers: bearer(reviewerToken),
        body: uploadForm("reviewer.txt", "Reviewer cannot mutate evidence."),
      }),
    );
    assert.equal(reviewerUpload.status, 403);
    assert.equal(reviewerUpload.body.code, "FORBIDDEN");

    const reviewerBatch = await jsonResponse(
      await fetch(batchUrl(matter.id), {
        method: "POST",
        headers: bearer(reviewerToken),
        body: batchForm("must-not-process.exe", "not a supported document"),
      }),
    );
    assert.equal(reviewerBatch.status, 403);
    assert.notEqual(reviewerBatch.status, 207);
    const reviewerRetry = await jsonResponse(
      await fetch(retryUrl(matter.id, uploadedDocumentId), {
        method: "POST",
        headers: bearer(reviewerToken),
      }),
    );
    assert.equal(reviewerRetry.status, 403);
    assert.equal(reviewerRetry.body.code, "FORBIDDEN");
    assert.equal(documentCount(), beforeReadOnlyDenials);

    const missingBatch = await jsonResponse(
      await fetch(batchUrl("missing-matter"), {
        method: "POST",
        headers: bearer(counselToken),
        body: batchForm("missing.exe", "must not be processed"),
      }),
    );
    assert.equal(missingBatch.status, 404);

    const retrySource = (await repository.uploadMatterDocument(
      owner,
      matter.id,
      {
        filename: "shared-retry-success.txt",
        mimeType: "text/plain",
        sizeBytes: 65,
        buffer: Buffer.from(
          "Retry restores the shared counsel's distinctive deadline evidence.",
        ),
      },
    )) as JsonBody;
    const retryMetadataBefore = retrySource.metadata as JsonBody;
    db.prepare(
      `update aletheia_matter_documents set parsed_status = 'failed'
       where id = ? and matter_id = ? and user_id = ?`,
    ).run(retrySource.id, matter.id, owner.userId);
    const retrySuccess = await jsonResponse(
      await fetch(retryUrl(matter.id, retrySource.id), {
        method: "POST",
        headers: bearer(counselToken),
      }),
    );
    assert.equal(retrySuccess.status, 200);
    assert.equal(retrySuccess.body.user_id, owner.userId);
    assertNoInternalDocumentPaths(retrySuccess.body);
    assert.equal(
      retrySuccess.body.metadata.originalSha256,
      retryMetadataBefore.originalSha256,
    );
    const retryChunks = db
      .prepare(
        `select user_id, text from aletheia_document_chunks
         where matter_id = ? and document_id = ?`,
      )
      .all(matter.id, retrySource.id) as Array<{
      user_id: string;
      text: string;
    }>;
    assert.ok(retryChunks.length > 0);
    assert.ok(retryChunks.every((row) => row.user_id === owner.userId));
    assert.ok(
      retryChunks.some((row) => row.text.includes("deadline evidence")),
    );
    const retryFts = db
      .prepare(
        `select text from aletheia_document_chunks_fts
         where matter_id = ? and document_id = ?`,
      )
      .all(matter.id, retrySource.id) as Array<{ text: string }>;
    assert.ok(retryFts.some((row) => row.text.includes("deadline evidence")));

    const matterDetail = await jsonResponse(
      await fetch(`${baseUrl}/aletheia/matters/${matter.id}`, {
        headers: bearer(process.env.ALETHEIA_PRIVATE_AUTH_TOKEN!),
      }),
    );
    assert.equal(matterDetail.status, 200);
    assertNoInternalDocumentPaths(matterDetail.body);
    const sourceIndex = await jsonResponse(
      await fetch(`${baseUrl}/aletheia/matters/${matter.id}/v1/source-index`, {
        headers: bearer(process.env.ALETHEIA_PRIVATE_AUTH_TOKEN!),
      }),
    );
    assert.equal(sourceIndex.status, 200);
    assertNoInternalDocumentPaths(sourceIndex.body);

    const failedSource = (await repository.uploadMatterDocument(
      owner,
      matter.id,
      {
        filename: "shared-retry-failure.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 18,
        buffer: Buffer.from("not-a-valid-docx"),
      },
    )) as JsonBody;
    assert.equal(failedSource.parsed_status, "failed");
    const retryFailure = await jsonResponse(
      await fetch(retryUrl(matter.id, failedSource.id), {
        method: "POST",
        headers: bearer(counselToken),
      }),
    );
    assert.equal(retryFailure.status, 422);
    assert.equal(retryFailure.body.code, "document_parse_retry_failed");

    const retryAudits = db
      .prepare(
        `select user_id, action, details from aletheia_audit_events
         where matter_id = ? and action in (
           'document_parse_retry_succeeded', 'document_parse_retry_failed'
         ) order by created_at asc`,
      )
      .all(matter.id) as Array<{
      user_id: string;
      action: string;
      details: string;
    }>;
    for (const event of retryAudits) {
      const details = JSON.parse(event.details);
      assert.equal(event.user_id, owner.userId);
      assert.equal(details.actorId, counselId);
      assert.equal(details.independentActor, true);
    }
    assert.ok(
      retryAudits.some(
        (event) =>
          event.action === "document_parse_retry_succeeded" &&
          JSON.parse(event.details).documentId === retrySource.id,
      ),
    );
    assert.ok(
      retryAudits.some(
        (event) =>
          event.action === "document_parse_retry_failed" &&
          JSON.parse(event.details).documentId === failedSource.id,
      ),
    );

    const crossMatter = await jsonResponse(
      await fetch(retryUrl(otherMatter.id, retrySource.id), {
        method: "POST",
        headers: bearer(counselToken),
      }),
    );
    assert.equal(crossMatter.status, 404);

    governance.updateGovernance(owner.userId, matter.id, {
      evidenceLocked: true,
      evidenceLockReason: "Sealed by the ACL audit",
    });
    const lockedUpload = await jsonResponse(
      await fetch(uploadUrl(matter.id), {
        method: "POST",
        headers: bearer(counselToken),
        body: uploadForm("locked.txt", "Locked evidence must fail closed."),
      }),
    );
    assert.equal(lockedUpload.status, 403);
    assert.equal(lockedUpload.body.code, "EVIDENCE_LOCKED");
    const lockedRetry = await jsonResponse(
      await fetch(retryUrl(matter.id, failedSource.id), {
        method: "POST",
        headers: bearer(counselToken),
      }),
    );
    assert.equal(lockedRetry.status, 403);
    assert.equal(lockedRetry.body.code, "EVIDENCE_LOCKED");
    const lockedBatch = await jsonResponse(
      await fetch(batchUrl(matter.id), {
        method: "POST",
        headers: bearer(counselToken),
        body: batchForm("locked.exe", "Locked batch must not be processed"),
      }),
    );
    assert.equal(lockedBatch.status, 403);
    assert.notEqual(lockedBatch.status, 207);
    assert.equal(lockedBatch.body.code, "EVIDENCE_LOCKED");
    governance.updateGovernance(owner.userId, matter.id, {
      evidenceLocked: false,
      evidenceLockReason: null,
    });

    db.prepare(
      "delete from aletheia_matter_acl where matter_id = ? and principal_id = ?",
    ).run(matter.id, counselId);
    const revokedUpload = await jsonResponse(
      await fetch(uploadUrl(matter.id), {
        method: "POST",
        headers: bearer(counselToken),
        body: uploadForm("revoked.txt", "Revoked ACL cannot write."),
      }),
    );
    assert.equal(revokedUpload.status, 403);
    assert.equal(revokedUpload.body.code, "FORBIDDEN");
    const revokedRetry = await jsonResponse(
      await fetch(retryUrl(matter.id, failedSource.id), {
        method: "POST",
        headers: bearer(counselToken),
      }),
    );
    assert.equal(revokedRetry.status, 403);
    assert.equal(revokedRetry.body.code, "FORBIDDEN");
    const revokedBatch = await jsonResponse(
      await fetch(batchUrl(matter.id), {
        method: "POST",
        headers: bearer(counselToken),
        body: batchForm("revoked.exe", "Revoked batch must not be processed"),
      }),
    );
    assert.equal(revokedBatch.status, 403);
    assert.notEqual(revokedBatch.status, 207);
    assert.equal(revokedBatch.body.code, "FORBIDDEN");

    console.log(
      JSON.stringify(
        {
          ok: true,
          counselUploadOwner: uploadedRow.user_id,
          uploadActor: uploadDetails.actorId,
          reviewerUpload: reviewerUpload.status,
          reviewerBatchPreflight: reviewerBatch.status,
          missingMatterBatch: missingBatch.status,
          retrySuccess: retrySuccess.status,
          retryFailure: retryFailure.status,
          crossMatter: crossMatter.status,
          evidenceLock: lockedUpload.status,
          revokedAcl: revokedUpload.status,
          retryAuditEvents: retryAudits.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeServer(server);
    db.close();
    identities.close();
    governance.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
