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
  assert.equal(text.includes("derivedStoragePath"), false);
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-source-original-verification-acl-"),
  );
  const ownerToken = "source-original-verification-owner-token";
  const auditSecret = "source-original-verification-acl-audit-secret";
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = ownerToken;
  process.env.ALETHEIA_LOCAL_USER_ID = "source-original-verification-owner";
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
      userId: "source-original-verification-owner",
      userEmail: "owner@local.invalid",
    };
    const counselId = "source-original-verification-counsel";
    const reviewerId = "source-original-verification-reviewer";
    const auditorId = "source-original-verification-auditor";
    const unsharedId = "source-original-verification-unshared";
    const repository = new LocalAletheiaRepository();
    const matterInput = {
      objective: "Verify original-source verification owner and actor separation.",
      template: "civil_litigation" as const,
      status: "in_progress" as const,
      riskLevel: "high" as const,
      clientOrProject: null,
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: "source_original_verification_acl" },
    };
    const matter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification ACL matter",
    })) as { id: string };
    const otherMatter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification ACL isolation matter",
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
      const documentId = `source-original-verification-document-${label}`;
      const chunkId = `source-original-verification-chunk-${label}`;
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
      return { ...source, chunkId };
    };
    const ownerSource = await sourceSpanForFact("owner");
    const counselSource = await sourceSpanForFact("counsel");
    const reviewerSource = await sourceSpanForFact("reviewer");
    const auditorSource = await sourceSpanForFact("auditor");
    const unsharedSource = await sourceSpanForFact("unshared");
    const revokedSource = await sourceSpanForFact("revoked");
    const shortReasonSource = await sourceSpanForFact("short-reason");
    const tamperedSource = await sourceSpanForFact("tampered");
    const auditFailureSource = await sourceSpanForFact("audit-failure");

    const app = express();
    app.use(express.json());
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const verify = (
      token: string,
      sourceSpanId: string,
      reason = "Compared the payment wording against the original scan.",
      targetMatterId = matter.id,
    ) =>
      fetch(
        `${baseUrl}/aletheia/matters/${targetMatterId}/litigation/source-spans/${sourceSpanId}/verify-original`,
        {
          method: "POST",
          headers: { ...bearer(token), "content-type": "application/json" },
          body: JSON.stringify({ reason, verifiedBy: "request-payload-must-not-win" }),
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
    const verificationAuditCount = () =>
      Number(
        (
          db!
            .prepare(
              `select count(*) as count from aletheia_audit_events
                where action = 'litigation_source_original_scan_verified'`,
            )
            .get() as { count: number }
        ).count,
      );
    const assertDeniedWithoutWrites = async (
      token: string,
      sourceSpanId: string,
      targetMatterId = matter.id,
    ) => {
      const beforeRows = verificationCount();
      const beforeAudits = verificationAuditCount();
      const response = await jsonResponse(
        await verify(token, sourceSpanId, undefined, targetMatterId),
      );
      assert.equal(response.status, 403);
      assert.equal(response.body.code, "FORBIDDEN");
      assertPathFree(response.body, root);
      assert.equal(verificationCount(), beforeRows);
      assert.equal(verificationAuditCount(), beforeAudits);
    };

    const ownerVerification = await jsonResponse(
      await verify(ownerToken, ownerSource.id),
    );
    assert.equal(ownerVerification.status, 201);
    assert.equal(ownerVerification.body.user_id, owner.userId);
    assert.equal(ownerVerification.body.verified_by, owner.userId);
    assertPathFree(ownerVerification.body, root);

    const counselVerification = await jsonResponse(
      await verify(counselToken, counselSource.id),
    );
    assert.equal(counselVerification.status, 201);
    assert.equal(counselVerification.body.user_id, owner.userId);
    assert.equal(counselVerification.body.verified_by, counselId);
    assert.notEqual(counselVerification.body.verified_by, "request-payload-must-not-win");
    assertPathFree(counselVerification.body, root);
    const counselAudit = db
      .prepare(
        `select * from aletheia_audit_events
          where matter_id = ? and action = 'litigation_source_original_scan_verified'
            and json_extract(details, '$.verificationId') = ?`,
      )
      .get(matter.id, counselVerification.body.id) as Json;
    assert.equal(counselAudit.user_id, owner.userId);
    assert.equal(counselAudit.matter_id, matter.id);
    const auditDetails = JSON.parse(counselAudit.details) as Json;
    assert.deepEqual(auditDetails, {
      sourceSpanId: counselSource.id,
      verificationId: counselVerification.body.id,
      sourceChunkSha256: counselSource.source_chunk_sha256,
      quoteSha256: counselSource.quote_sha256,
      reason: counselVerification.body.reason,
      actorId: counselId,
      ownerId: owner.userId,
      crossPrincipal: true,
      independentActor: true,
    });
    const expectedAuditHash = `hmac-sha256:${createHmac("sha256", auditSecret)
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
      .digest("hex")}`;
    assert.equal(counselAudit.event_hash, expectedAuditHash);

    const restartedRepository = new LocalAletheiaRepository();
    for (const ctx of [owner, { userId: counselId, userEmail: "counsel@local.invalid" }]) {
      const workspace = (await restartedRepository.getLitigationWorkspace(
        ctx,
        matter.id,
      )) as { fact_sources: Array<Json> };
      assert.equal(
        workspace.fact_sources.find(
          (item) => item.source_span_id === counselSource.id,
        )?.current_verification_id,
        counselVerification.body.id,
      );
    }

    await assertDeniedWithoutWrites(reviewerToken, reviewerSource.id);
    await assertDeniedWithoutWrites(auditorToken, auditorSource.id);
    await assertDeniedWithoutWrites(unsharedToken, unsharedSource.id);
    db
      .prepare(
        "delete from aletheia_matter_acl where matter_id = ? and principal_id = ?",
      )
      .run(matter.id, counselId);
    await assertDeniedWithoutWrites(counselToken, revokedSource.id);

    const beforeCrossMatterRows = verificationCount();
    const beforeCrossMatterAudits = verificationAuditCount();
    const crossMatter = await jsonResponse(
      await verify(ownerToken, ownerSource.id, undefined, otherMatter.id),
    );
    assert.equal(crossMatter.status, 404);
    assertPathFree(crossMatter.body, root);
    assert.equal(verificationCount(), beforeCrossMatterRows);
    assert.equal(verificationAuditCount(), beforeCrossMatterAudits);

    const beforeShortReasonRows = verificationCount();
    const beforeShortReasonAudits = verificationAuditCount();
    const shortReason = await jsonResponse(
      await verify(ownerToken, shortReasonSource.id, "too short"),
    );
    assert.equal(shortReason.status, 400);
    assertPathFree(shortReason.body, root);
    assert.equal(verificationCount(), beforeShortReasonRows);
    assert.equal(verificationAuditCount(), beforeShortReasonAudits);

    db.prepare("update aletheia_document_chunks set text = ? where id = ?").run(
      `${sourceText} tampered`,
      tamperedSource.chunkId,
    );
    const beforeTamperedRows = verificationCount();
    const beforeTamperedAudits = verificationAuditCount();
    const tampered = await jsonResponse(
      await verify(ownerToken, tamperedSource.id),
    );
    assert.equal(tampered.status, 400);
    assertPathFree(tampered.body, root);
    assert.equal(verificationCount(), beforeTamperedRows);
    assert.equal(verificationAuditCount(), beforeTamperedAudits);

    db.exec(`create trigger fail_source_original_verification_audit
      before insert on aletheia_audit_events
      when new.action = 'litigation_source_original_scan_verified'
      begin select raise(abort, 'forced original verification audit failure'); end;`);
    const beforeAuditFailureRows = verificationCount();
    const beforeAuditFailureAudits = verificationAuditCount();
    const originalConsoleError = console.error;
    let auditFailure: { status: number; body: Json };
    console.error = () => undefined;
    try {
      auditFailure = await jsonResponse(
        await verify(ownerToken, auditFailureSource.id),
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(auditFailure.status, 500);
    assertPathFree(auditFailure.body, root);
    assert.equal(verificationCount(), beforeAuditFailureRows);
    assert.equal(verificationAuditCount(), beforeAuditFailureAudits);
    db.exec("drop trigger fail_source_original_verification_audit");

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-source-original-verification-acl-audit-v1",
          ownerVerification: ownerVerification.body.id,
          counselVerification: counselVerification.body.id,
          deniedRoles: [reviewerId, auditorId, unsharedId, counselId],
          restartProjection: counselVerification.body.id,
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
