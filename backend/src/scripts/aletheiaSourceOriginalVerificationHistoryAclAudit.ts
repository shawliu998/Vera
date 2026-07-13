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
  assert.equal(text.includes("storage_path"), false);
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-source-verification-history-"),
  );
  const ownerToken = "source-verification-history-owner-token";
  const auditSecret = "source-verification-history-audit-secret";
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = ownerToken;
  process.env.ALETHEIA_LOCAL_USER_ID = "source-verification-history-owner";
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
      userId: "source-verification-history-owner",
      userEmail: "owner@local.invalid",
    };
    const counselId = "source-verification-history-counsel";
    const reviewerId = "source-verification-history-reviewer";
    const auditorId = "source-verification-history-auditor";
    const unsharedId = "source-verification-history-unshared";
    const repository = new LocalAletheiaRepository();
    const matterInput = {
      objective: "Audit source original verification history access.",
      template: "civil_litigation" as const,
      status: "in_progress" as const,
      riskLevel: "high" as const,
      clientOrProject: null,
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: "source_original_verification_history_acl" },
    };
    const matter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification history ACL matter",
    })) as { id: string };
    const otherMatter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification history isolation matter",
    })) as { id: string };
    const purgeMatter = (await repository.createMatter(owner, {
      ...matterInput,
      title: "Original verification history purge matter",
    })) as { id: string };

    const databasePath = path.join(root, "aletheia.db");
    const governance = new LocalGovernanceService({
      databasePath,
      multiPrincipalEnabled: true,
    });
    for (const matterId of [matter.id, otherMatter.id, purgeMatter.id]) {
      governance.governance(owner.userId, matterId);
    }
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
    const sourceSpanForMatter = async (matterId: string, label: string) => {
      const documentId = `source-verification-history-document-${label}`;
      const chunkId = `source-verification-history-chunk-${label}`;
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
          matterId,
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
          matterId,
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
      const fact = (await repository.createLitigationFact(owner, matterId, {
        statement: `Payment evidence ${label}.`,
        source: {
          sourceChunkId: chunkId,
          quoteStart,
          quoteEnd: quoteStart + quote.length,
        },
      })) as { id: string };
      return db!
        .prepare(
          `select s.id, s.source_chunk_sha256, s.quote_sha256, c.id as chunk_id
             from aletheia_source_spans s
             join aletheia_litigation_fact_sources fs on fs.source_span_id = s.id
             join aletheia_document_chunks c on c.id = s.source_chunk_id
            where fs.fact_id = ? and s.matter_id = ? and s.user_id = ?`,
        )
        .get(fact.id, matterId, owner.userId) as {
        id: string;
        source_chunk_sha256: string;
        quote_sha256: string;
        chunk_id: string;
      };
    };
    const source = await sourceSpanForMatter(matter.id, "history");
    const auditFailureSource = await sourceSpanForMatter(matter.id, "audit");
    const purgeSource = await sourceSpanForMatter(purgeMatter.id, "purge");

    const app = express();
    app.use(express.json());
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const verify = (token: string, sourceSpanId: string, matterId = matter.id) =>
      fetch(
        `${baseUrl}/aletheia/matters/${matterId}/litigation/source-spans/${sourceSpanId}/verify-original`,
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
      matterId = matter.id,
    ) =>
      fetch(
        `${baseUrl}/aletheia/matters/${matterId}/litigation/source-spans/${sourceSpanId}/verifications/${verificationId}/withdraw`,
        {
          method: "POST",
          headers: { ...bearer(token), "content-type": "application/json" },
          body: JSON.stringify({
            reason: "The original comparison must be redone after further review.",
          }),
        },
      );
    const history = (token: string, sourceSpanId: string, matterId = matter.id) =>
      fetch(
        `${baseUrl}/aletheia/matters/${matterId}/litigation/source-spans/${sourceSpanId}/original-verification-history`,
        { headers: bearer(token) },
      );
    const historyAuditCount = () =>
      Number(
        (
          db!
            .prepare(
              `select count(*) as count from aletheia_audit_events
               where action = 'litigation_source_original_scan_verification_history_read'`,
            )
            .get() as { count: number }
        ).count,
      );

    const firstVerification = await jsonResponse(await verify(ownerToken, source.id));
    assert.equal(firstVerification.status, 201);
    const firstWithdrawal = await jsonResponse(
      await withdraw(ownerToken, source.id, firstVerification.body.id),
    );
    assert.equal(firstWithdrawal.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondVerification = await jsonResponse(
      await verify(counselToken, source.id),
    );
    assert.equal(secondVerification.status, 201);

    const initialHistory = await jsonResponse(await history(ownerToken, source.id));
    assert.equal(initialHistory.status, 200);
    assert.equal(initialHistory.body.source_span_id, source.id);
    assert.ok(Array.isArray(initialHistory.body.items));
    assert.equal(initialHistory.body.items.length, 2);
    assert.deepEqual(
      initialHistory.body.items.map((item: Json) => item.id),
      [firstVerification.body.id, secondVerification.body.id],
    );
    assert.deepEqual(initialHistory.body.items[0], {
      id: firstVerification.body.id,
      verification_type: "original_scan_compared",
      source_chunk_sha256: source.source_chunk_sha256,
      quote_sha256: source.quote_sha256,
      reason: firstVerification.body.reason,
      verified_by: owner.userId,
      verified_at: firstVerification.body.verified_at,
      withdrawal: {
        id: firstWithdrawal.body.id,
        reason: firstWithdrawal.body.reason,
        withdrawn_by: owner.userId,
        withdrawn_at: firstWithdrawal.body.withdrawn_at,
      },
      current: false,
    });
    assert.equal(initialHistory.body.items[1].withdrawal, null);
    assert.equal(initialHistory.body.items[1].verified_by, counselId);
    assert.equal(initialHistory.body.items[1].current, true);
    assertPathFree(initialHistory.body, root);
    const initialAudit = db
      .prepare(
        `select * from aletheia_audit_events
          where action = 'litigation_source_original_scan_verification_history_read'
          order by sequence desc limit 1`,
      )
      .get() as Json;
    const initialAuditDetails = JSON.parse(initialAudit.details) as Json;
    assert.deepEqual(initialAuditDetails, {
      sourceSpanId: source.id,
      historyCount: 2,
      currentVerificationIds: [secondVerification.body.id],
      actorId: owner.userId,
      ownerId: owner.userId,
      crossPrincipal: false,
      independentActor: false,
    });
    assert.equal(
      initialAudit.event_hash,
      `hmac-sha256:${createHmac("sha256", auditSecret)
        .update(
          stableJson({
            id: initialAudit.id,
            matterId: initialAudit.matter_id,
            userId: initialAudit.user_id,
            actor: initialAudit.actor,
            action: initialAudit.action,
            workflowVersion: initialAudit.workflow_version,
            model: initialAudit.model,
            details: initialAuditDetails,
            createdAt: initialAudit.created_at,
            sequence: initialAudit.sequence,
            previousHash: initialAudit.previous_hash,
          }),
        )
        .digest("hex")}`,
    );

    for (const token of [counselToken, reviewerToken, auditorToken]) {
      const response = await jsonResponse(await history(token, source.id));
      assert.equal(response.status, 200);
      assert.equal(response.body.source_span_id, source.id);
      assert.equal(response.body.items.length, 2);
      assertPathFree(response.body, root);
    }
    const denied = async (token: string, sourceSpanId = source.id) => {
      const beforeAudits = historyAuditCount();
      const response = await jsonResponse(await history(token, sourceSpanId));
      assert.equal(response.status, 403);
      assert.equal(response.body.code, "FORBIDDEN");
      assertPathFree(response.body, root);
      assert.equal(historyAuditCount(), beforeAudits);
    };
    await denied(unsharedToken);
    db
      .prepare(
        "delete from aletheia_matter_acl where matter_id = ? and principal_id = ?",
      )
      .run(matter.id, counselId);
    await denied(counselToken);
    const beforeCrossMatterAudits = historyAuditCount();
    const crossMatter = await jsonResponse(
      await history(ownerToken, source.id, otherMatter.id),
    );
    assert.equal(crossMatter.status, 404);
    assertPathFree(crossMatter.body, root);
    assert.equal(historyAuditCount(), beforeCrossMatterAudits);

    db.prepare("update aletheia_document_chunks set text = ? where id = ?").run(
      `${sourceText} later OCR correction`,
      source.chunk_id,
    );
    const staleHistory = await jsonResponse(await history(ownerToken, source.id));
    assert.equal(staleHistory.status, 200);
    assert.deepEqual(
      staleHistory.body.items.map((item: Json) => item.current),
      [false, false],
    );
    assert.deepEqual(
      staleHistory.body.items.map((item: Json) => item.source_chunk_sha256),
      [source.source_chunk_sha256, source.source_chunk_sha256],
    );
    assert.deepEqual(
      staleHistory.body.items.map((item: Json) => item.quote_sha256),
      [source.quote_sha256, source.quote_sha256],
    );

    const auditFailureVerification = await jsonResponse(
      await verify(ownerToken, auditFailureSource.id),
    );
    assert.equal(auditFailureVerification.status, 201);
    db.exec(`create trigger fail_source_verification_history_audit
      before insert on aletheia_audit_events
      when new.action = 'litigation_source_original_scan_verification_history_read'
      begin select raise(abort, 'forced history audit failure'); end;`);
    const beforeAuditFailureAudits = historyAuditCount();
    const auditFailure = await jsonResponse(
      await history(ownerToken, auditFailureSource.id),
    );
    assert.equal(auditFailure.status, 503);
    assert.equal(
      auditFailure.body.code,
      "source_original_verification_history_audit_failed",
    );
    assert.equal(JSON.stringify(auditFailure.body).includes(auditFailureSource.id), false);
    assertPathFree(auditFailure.body, root);
    assert.equal(historyAuditCount(), beforeAuditFailureAudits);
    db.exec("drop trigger fail_source_verification_history_audit");

    const purgeVerification = await jsonResponse(
      await verify(ownerToken, purgeSource.id, purgeMatter.id),
    );
    assert.equal(purgeVerification.status, 201);
    const purgeWithdrawal = await jsonResponse(
      await withdraw(
        ownerToken,
        purgeSource.id,
        purgeVerification.body.id,
        purgeMatter.id,
      ),
    );
    assert.equal(purgeWithdrawal.status, 201);
    assert.throws(
      () =>
        db!
          .prepare(
            "delete from aletheia_source_span_verification_withdrawals where id = ?",
          )
          .run(purgeWithdrawal.body.id),
      /source span verification withdrawals are immutable/,
    );
    assert.throws(
      () =>
        db!
          .prepare("delete from aletheia_source_span_verifications where id = ?")
          .run(purgeVerification.body.id),
      /source span verifications are immutable/,
    );
    const purgeApproval = (await repository.requestApproval(owner, purgeMatter.id, {
      action: "matter_purge",
      requestedPayload: { matterId: purgeMatter.id },
    })) as { id: string };
    await repository.decideApproval(owner, purgeMatter.id, purgeApproval.id, {
      decision: "approved",
    });
    const purgeResult = (await repository.purgeMatter(
      owner,
      purgeMatter.id,
      purgeApproval.id,
    )) as { id: string };
    assert.ok(purgeResult.id);
    assert.equal(
      (
        db
          .prepare(
            "select count(*) as count from aletheia_source_span_verifications where matter_id = ?",
          )
          .get(purgeMatter.id) as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        db
          .prepare(
            "select count(*) as count from aletheia_source_span_verification_withdrawals where matter_id = ?",
          )
          .get(purgeMatter.id) as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        db
          .prepare(
            "select count(*) as count from aletheia_deletion_tombstones where matter_id = ?",
          )
          .get(purgeMatter.id) as { count: number }
      ).count,
      1,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-source-original-verification-history-acl-audit-v1",
          historyIds: [firstVerification.body.id, secondVerification.body.id],
          purgeTombstoneId: purgeResult.id,
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
