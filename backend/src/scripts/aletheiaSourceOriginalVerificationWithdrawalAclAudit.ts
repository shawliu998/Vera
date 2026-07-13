import "dotenv/config";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

type Json = Record<string, any>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function jsonResponse(response: Response) {
  return { status: response.status, body: (await response.json()) as Json };
}

function assertPathFree(value: unknown, root: string) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(root), false);
  assert.equal(text.includes("storagePath"), false);
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-source-verification-withdrawal-"),
  );
  const ownerToken = "source-verification-withdrawal-owner-token";
  const auditSecret = "source-verification-withdrawal-audit-secret";
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = ownerToken;
  process.env.ALETHEIA_LOCAL_USER_ID = "source-verification-withdrawal-owner";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "owner@local.invalid";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";
  process.env.ALETHEIA_AUDIT_HMAC_SECRET = auditSecret;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  process.env.ALETHEIA_MALWARE_SCAN_MODE = "disabled";
  process.env.ALETHEIA_CDR_MODE = "disabled";

  let server: http.Server | null = null;
  let db: InstanceType<typeof LocalDatabase> | null = null;
  try {
    const [
      { LocalAletheiaRepository },
      { LocalDatabase },
      { LocalGovernanceService },
      { LocalIdentityRepository },
      { litigationRouter },
    ] = await Promise.all([
      import("../lib/aletheia/localRepository"),
      import("../lib/aletheia/localDatabase"),
      import("../lib/aletheia/localGovernance"),
      import("../lib/aletheia/localIdentity"),
      import("../routes/litigation"),
    ]);
    const owner = {
      userId: "source-verification-withdrawal-owner",
      userEmail: "owner@local.invalid",
    };
    const counselId = "source-verification-withdrawal-counsel";
    const reviewerId = "source-verification-withdrawal-reviewer";
    const auditorId = "source-verification-withdrawal-auditor";
    const unsharedId = "source-verification-withdrawal-unshared";
    const repository = new LocalAletheiaRepository();
    const matterInput = {
      objective: "Audit immutable source verification withdrawal ACL behavior.",
      template: "civil_litigation" as const,
      status: "in_progress" as const,
      riskLevel: "high" as const,
      clientOrProject: null,
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: "source_original_verification_withdrawal_acl" },
    };
    const matter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification withdrawal ACL matter",
    })) as { id: string };
    const otherMatter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification withdrawal isolation matter",
    })) as { id: string };
    const databasePath = path.join(root, "aletheia.db");
    const governance = new LocalGovernanceService({
      databasePath,
      multiPrincipalEnabled: true,
    });
    governance.governance(owner.userId, matter.id);
    governance.governance(owner.userId, otherMatter.id);
    for (const [id, displayName, roles] of [
      [counselId, "Shared Counsel", ["counsel"]],
      [reviewerId, "Read-only Reviewer", ["reviewer"]],
      [auditorId, "Read-only Auditor", ["auditor"]],
      [unsharedId, "Unshared Principal", ["reviewer"]],
    ] as const) {
      governance.createPrincipal(owner.userId, { id, displayName, roles });
    }
    governance.setMatterAcl(owner.userId, matter.id, counselId, "counsel");
    governance.setMatterAcl(owner.userId, otherMatter.id, counselId, "counsel");
    governance.setMatterAcl(owner.userId, matter.id, reviewerId, "reviewer");
    governance.setMatterAcl(owner.userId, matter.id, auditorId, "auditor");

    const identities = new LocalIdentityRepository({ databasePath });
    const issueToken = (principalId: string) =>
      identities.issueToken({
        principalId,
        createdBy: owner.userId,
        email: `${principalId}@local.invalid`,
      }).token;
    const counselToken = issueToken(counselId);
    const reviewerToken = issueToken(reviewerId);
    const auditorToken = issueToken(auditorId);
    const unsharedToken = issueToken(unsharedId);
    db = new LocalDatabase(databasePath);

    const sourceText = "Scanned record: payment was made on 2026-07-01.";
    const quote = "payment was made";
    const quoteStart = sourceText.indexOf(quote);
    const sourceSpanForFact = async (label: string) => {
      const documentId = `source-verification-withdrawal-document-${label}`;
      const chunkId = `source-verification-withdrawal-chunk-${label}`;
      const timestamp = new Date().toISOString();
      db!
        .prepare(
          `insert into aletheia_matter_documents (
            id, matter_id, user_id, name, document_type, parsed_status,
            metadata, created_at, updated_at
          ) values (?, ?, ?, ?, 'court_filing', 'parsed', '{}', ?, ?)`,
        )
        .run(
          documentId,
          matter.id,
          owner.userId,
          `${label}.txt`,
          timestamp,
          timestamp,
        );
      db!
        .prepare(
          `insert into aletheia_document_chunks (
            id, matter_id, document_id, user_id, chunk_index, page, section,
            text, quote_start, quote_end, metadata, created_at
          ) values (?, ?, ?, ?, 0, 1, 'scan', ?, 0, ?, ?, ?)`,
        )
        .run(
          chunkId,
          matter.id,
          documentId,
          owner.userId,
          sourceText,
          sourceText.length,
          JSON.stringify({
            ocrProvenance: {
              engine: "apple-vision",
              page: 1,
              confidence: 0.55,
            },
          }),
          timestamp,
        );
      const fact = (await repository.createLitigationFact(owner, matter.id, {
        statement: `Payment evidence ${label}.`,
        source: {
          sourceChunkId: chunkId,
          quoteStart,
          quoteEnd: quoteStart + quote.length,
        },
      })) as { id: string };
      const source = db!
        .prepare(
          `select s.id, s.source_chunk_sha256, s.quote_sha256
             from aletheia_source_spans s
             join aletheia_litigation_fact_sources fs on fs.source_span_id = s.id
            where fs.fact_id = ? and s.matter_id = ? and s.user_id = ?`,
        )
        .get(fact.id, matter.id, owner.userId) as {
        id: string;
        source_chunk_sha256: string;
        quote_sha256: string;
      };
      return { ...source, chunkId, factId: fact.id };
    };

    const ownerSource = await sourceSpanForFact("owner");
    const counselSource = await sourceSpanForFact("counsel");
    const reviewerSource = await sourceSpanForFact("reviewer");
    const auditorSource = await sourceSpanForFact("auditor");
    const unsharedSource = await sourceSpanForFact("unshared");
    const revokedSource = await sourceSpanForFact("revoked");
    const auditFailureSource = await sourceSpanForFact("audit-failure");

    const app = express();
    app.use(express.json());
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const verify = (token: string, sourceSpanId: string) =>
      fetch(
        `${baseUrl}/aletheia/matters/${matter.id}/litigation/source-spans/${sourceSpanId}/verify-original`,
        {
          method: "POST",
          headers: { ...bearer(token), "content-type": "application/json" },
          body: JSON.stringify({
            reason: "Compared the payment wording against the original scan.",
          }),
        },
      );
    const withdraw = (
      token: string,
      sourceSpanId: string,
      verificationId: string,
      options: { reason?: string; targetMatterId?: string } = {},
    ) =>
      fetch(
        `${baseUrl}/aletheia/matters/${options.targetMatterId ?? matter.id}/litigation/source-spans/${sourceSpanId}/verifications/${verificationId}/withdraw`,
        {
          method: "POST",
          headers: { ...bearer(token), "content-type": "application/json" },
          body: JSON.stringify({
            reason:
              options.reason ??
              "The original comparison must be redone after further review.",
          }),
        },
      );
    const verificationCount = () =>
      Number(
        (
          db!
            .prepare(
              "select count(*) as count from aletheia_source_span_verifications",
            )
            .get() as { count: number }
        ).count,
      );
    const withdrawalCount = () =>
      Number(
        (
          db!
            .prepare(
              "select count(*) as count from aletheia_source_span_verification_withdrawals",
            )
            .get() as { count: number }
        ).count,
      );
    const withdrawalAuditCount = () =>
      Number(
        (
          db!
            .prepare(
              `select count(*) as count from aletheia_audit_events
              where action = 'litigation_source_original_scan_verification_withdrawn'`,
            )
            .get() as { count: number }
        ).count,
      );
    const assertDeniedWithoutWrites = async (
      token: string,
      sourceSpanId: string,
      verificationId: string,
    ) => {
      const beforeWithdrawals = withdrawalCount();
      const beforeAudits = withdrawalAuditCount();
      const response = await jsonResponse(
        await withdraw(token, sourceSpanId, verificationId),
      );
      assert.equal(response.status, 403);
      assert.equal(response.body.code, "FORBIDDEN");
      assertPathFree(response.body, root);
      assert.equal(withdrawalCount(), beforeWithdrawals);
      assert.equal(withdrawalAuditCount(), beforeAudits);
    };

    const ownerVerification = await jsonResponse(
      await verify(ownerToken, ownerSource.id),
    );
    assert.equal(ownerVerification.status, 201);
    const counselVerification = await jsonResponse(
      await verify(counselToken, counselSource.id),
    );
    assert.equal(counselVerification.status, 201);
    assert.equal(counselVerification.body.user_id, owner.userId);
    assert.equal(counselVerification.body.verified_by, counselId);

    db.prepare("update aletheia_document_chunks set text = ? where id = ?").run(
      `${sourceText} later OCR correction`,
      ownerSource.chunkId,
    );
    const ownerVerificationRows = verificationCount();
    const ownerWithdrawal = await jsonResponse(
      await withdraw(ownerToken, ownerSource.id, ownerVerification.body.id),
    );
    assert.equal(ownerWithdrawal.status, 201);
    assert.equal(
      ownerWithdrawal.body.verification_id,
      ownerVerification.body.id,
    );
    assert.equal(ownerWithdrawal.body.source_span_id, ownerSource.id);
    assert.equal(
      ownerWithdrawal.body.source_chunk_sha256,
      ownerSource.source_chunk_sha256,
    );
    assert.equal(ownerWithdrawal.body.quote_sha256, ownerSource.quote_sha256);
    assert.equal(ownerWithdrawal.body.withdrawn_by, owner.userId);
    assert.equal(verificationCount(), ownerVerificationRows);
    assert.throws(
      () =>
        db!
          .prepare(
            "update aletheia_source_span_verifications set reason = ? where id = ?",
          )
          .run("Attempted verification rewrite.", ownerVerification.body.id),
      /source span verifications are immutable/,
    );
    assert.throws(
      () =>
        db!
          .prepare(
            "delete from aletheia_source_span_verifications where id = ?",
          )
          .run(ownerVerification.body.id),
      /source span verifications are immutable/,
    );
    assert.throws(
      () =>
        db!
          .prepare(
            "update aletheia_source_span_verification_withdrawals set reason = ? where id = ?",
          )
          .run("Attempted withdrawal rewrite.", ownerWithdrawal.body.id),
      /source span verification withdrawals are immutable/,
    );
    assert.throws(
      () =>
        db!
          .prepare(
            "delete from aletheia_source_span_verification_withdrawals where id = ?",
          )
          .run(ownerWithdrawal.body.id),
      /source span verification withdrawals are immutable/,
    );

    const workspaceAfterOwnerWithdrawal =
      (await repository.getLitigationWorkspace(owner, matter.id)) as {
        fact_sources: Json[];
      };
    assert.equal(
      workspaceAfterOwnerWithdrawal.fact_sources.find(
        (item) => item.source_span_id === ownerSource.id,
      )?.current_verification_id,
      null,
    );
    const invalidConfirmation = await jsonResponse(
      await fetch(
        `${baseUrl}/aletheia/matters/${matter.id}/litigation/facts/${ownerSource.factId}/decision`,
        {
          method: "POST",
          headers: {
            ...bearer(ownerToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({ decision: "confirmed" }),
        },
      ),
    );
    assert.equal(invalidConfirmation.status, 400);

    const counselWithdrawal = await jsonResponse(
      await withdraw(
        counselToken,
        counselSource.id,
        counselVerification.body.id,
      ),
    );
    assert.equal(counselWithdrawal.status, 201);
    assert.equal(counselWithdrawal.body.user_id, owner.userId);
    assert.equal(counselWithdrawal.body.withdrawn_by, counselId);
    const counselAudit = db
      .prepare(
        `select * from aletheia_audit_events
          where matter_id = ?
            and action = 'litigation_source_original_scan_verification_withdrawn'
            and json_extract(details, '$.withdrawalId') = ?`,
      )
      .get(matter.id, counselWithdrawal.body.id) as Json;
    assert.equal(counselAudit.user_id, owner.userId);
    const auditDetails = JSON.parse(counselAudit.details) as Json;
    assert.deepEqual(auditDetails, {
      sourceSpanId: counselSource.id,
      verificationId: counselVerification.body.id,
      withdrawalId: counselWithdrawal.body.id,
      sourceChunkSha256: counselSource.source_chunk_sha256,
      quoteSha256: counselSource.quote_sha256,
      reason: counselWithdrawal.body.reason,
      actorId: counselId,
      ownerId: owner.userId,
      crossPrincipal: true,
      independentActor: true,
    });
    assert.equal(
      counselAudit.event_hash,
      `hmac-sha256:${createHmac("sha256", auditSecret)
        .update(
          stableJson({
            id: counselAudit.id,
            matterId: counselAudit.matter_id,
            userId: counselAudit.user_id,
            actor: counselAudit.actor,
            action: counselAudit.action,
            workflowVersion: counselAudit.workflow_version,
            model: counselAudit.model,
            details: auditDetails,
            createdAt: counselAudit.created_at,
            sequence: counselAudit.sequence,
            previousHash: counselAudit.previous_hash,
          }),
        )
        .digest("hex")}`,
    );

    const beforeDuplicateWithdrawals = withdrawalCount();
    const duplicate = await jsonResponse(
      await withdraw(ownerToken, ownerSource.id, ownerVerification.body.id),
    );
    assert.equal(duplicate.status, 409);
    assert.equal(withdrawalCount(), beforeDuplicateWithdrawals);

    const beforeWrongResourceWithdrawals = withdrawalCount();
    const wrongSource = await jsonResponse(
      await withdraw(
        ownerToken,
        reviewerSource.id,
        counselVerification.body.id,
      ),
    );
    assert.equal(wrongSource.status, 404);
    const wrongMatter = await jsonResponse(
      await withdraw(
        ownerToken,
        counselSource.id,
        counselVerification.body.id,
        {
          targetMatterId: otherMatter.id,
        },
      ),
    );
    assert.equal(wrongMatter.status, 404);
    const nonexistent = await jsonResponse(
      await withdraw(ownerToken, counselSource.id, "missing-verification-id"),
    );
    assert.equal(nonexistent.status, 404);
    const invalidReason = await jsonResponse(
      await withdraw(
        ownerToken,
        counselSource.id,
        counselVerification.body.id,
        {
          reason: "too short",
        },
      ),
    );
    assert.equal(invalidReason.status, 400);
    assert.equal(withdrawalCount(), beforeWrongResourceWithdrawals);

    await assertDeniedWithoutWrites(
      reviewerToken,
      reviewerSource.id,
      counselVerification.body.id,
    );
    await assertDeniedWithoutWrites(
      auditorToken,
      auditorSource.id,
      counselVerification.body.id,
    );
    await assertDeniedWithoutWrites(
      unsharedToken,
      unsharedSource.id,
      counselVerification.body.id,
    );
    db.prepare(
      "delete from aletheia_matter_acl where matter_id = ? and principal_id = ?",
    ).run(matter.id, counselId);
    await assertDeniedWithoutWrites(
      counselToken,
      revokedSource.id,
      counselVerification.body.id,
    );

    const auditFailureVerification = await jsonResponse(
      await verify(ownerToken, auditFailureSource.id),
    );
    assert.equal(auditFailureVerification.status, 201);
    db.exec(`create trigger fail_source_verification_withdrawal_audit
      before insert on aletheia_audit_events
      when new.action = 'litigation_source_original_scan_verification_withdrawn'
      begin select raise(abort, 'forced original verification withdrawal audit failure'); end;`);
    const beforeFailedWithdrawalRows = withdrawalCount();
    const beforeFailedWithdrawalAudits = withdrawalAuditCount();
    const originalConsoleError = console.error;
    let auditFailure: { status: number; body: Json };
    console.error = () => undefined;
    try {
      auditFailure = await jsonResponse(
        await withdraw(
          ownerToken,
          auditFailureSource.id,
          auditFailureVerification.body.id,
        ),
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(auditFailure.status, 500);
    assert.equal(withdrawalCount(), beforeFailedWithdrawalRows);
    assert.equal(withdrawalAuditCount(), beforeFailedWithdrawalAudits);
    const workspaceAfterAuditRollback =
      (await repository.getLitigationWorkspace(owner, matter.id)) as {
        fact_sources: Json[];
      };
    assert.equal(
      workspaceAfterAuditRollback.fact_sources.find(
        (item) => item.source_span_id === auditFailureSource.id,
      )?.current_verification_id,
      auditFailureVerification.body.id,
    );
    db.exec("drop trigger fail_source_verification_withdrawal_audit");

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite:
            "aletheia-source-original-verification-withdrawal-acl-audit-v1",
          ownerWithdrawal: ownerWithdrawal.body.id,
          counselWithdrawal: counselWithdrawal.body.id,
          deniedRoles: [reviewerId, auditorId, unsharedId, counselId],
          auditHash: counselAudit.event_hash,
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) await closeServer(server);
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
