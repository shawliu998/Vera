import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  AuditAnchorConfigurationError,
  findExactMatterAuditAnchorCoverage,
  generateAuditAnchorKeyPair,
  runAuditAnchorRuntimeNow,
  startAuditAnchorRuntimeFromEnvironment,
} from "../lib/aletheia/auditAnchorJournal";

function record(value: unknown) {
  return value as Record<string, any>;
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "vera-litigation-audit-package-"),
  );
  const anchorDir = `${dataDir}-anchors`;
  const keyDir = `${dataDir}-operator-keys`;
  let anchorRuntime: { close(): void } | null = null;
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const ctx = { userId: "audit-package-counsel" };
  try {
    const { createAletheiaRepository } = await import("../lib/aletheia");
    const repository = createAletheiaRepository();
    const matter = record(
      await repository.createMatter(ctx, {
        title: "Litigation matter audit package regression",
        objective: "Verify complete matter handoff and counsel sign-off.",
        template: "civil_litigation",
        status: "needs_review",
        riskLevel: "high",
        clientOrProject: "Synthetic payment dispute",
        sourceProjectId: null,
        sharedWith: [],
        metadata: {},
      }),
    );
    const matterId = String(matter.id);
    const sourceText =
      "The executed agreement fixed payment on 1 September 2026. The court listed the hearing for 10 October 2026.";
    await repository.uploadMatterDocument(ctx, matterId, {
      filename: "agreement-and-hearing.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(sourceText),
      buffer: Buffer.from(sourceText),
    });
    const sourceIndex = record(
      await repository.listV1SourceIndex(ctx, matterId, {
        includeChunks: true,
        includeEvidenceLinks: true,
        chunkLimit: 20,
      }),
    );
    const chunk = record(sourceIndex.chunks[0]);
    const paymentQuote = "payment on 1 September 2026";
    const hearingQuote = "hearing for 10 October 2026";
    const paymentStart = String(chunk.text).indexOf(paymentQuote);
    const hearingStart = String(chunk.text).indexOf(hearingQuote);
    assert(paymentStart >= 0 && hearingStart >= 0);

    const fact = record(
      await repository.createLitigationFact(ctx, matterId, {
        statement: "Payment was fixed for 1 September 2026.",
        occurredAt: "2026-09-01T00:00:00+08:00",
        datePrecision: "day",
        helpfulness: "helpful",
        confidence: "high",
        createdBy: "human",
        sourceRelation: "supports",
        source: {
          sourceChunkId: chunk.id,
          quoteStart: paymentStart,
          quoteEnd: paymentStart + paymentQuote.length,
        },
      }),
    );
    await repository.decideLitigationFact(ctx, matterId, fact.id, {
      decision: "confirmed",
      comment: "Counsel checked the executed agreement text.",
    });
    const claim = record(
      await repository.createLitigationClaim(ctx, matterId, {
        kind: "defense",
        title: "The payment defense follows the agreed performance date.",
        legalBasis: "Contract performance rule",
        confidence: "high",
        uncertainty: null,
        createdBy: "human",
        sourceRelation: "supports",
        source: {
          sourceChunkId: chunk.id,
          quoteStart: paymentStart,
          quoteEnd: paymentStart + paymentQuote.length,
        },
      }),
    );
    await repository.decideLitigationClaim(ctx, matterId, claim.id, {
      decision: "confirmed",
      comment: "Counsel confirmed the source-bound defense position.",
    });
    const authorityText =
      "Article 509 requires each party to perform its obligations as agreed.";
    const authority = record(
      await repository.createLitigationLegalAuthorityVersion(ctx, matterId, {
        authorityType: "statute",
        jurisdiction: "CN",
        title: "Civil Code",
        issuer: "National People's Congress",
        officialIdentifier: "Civil-Code-509",
        versionLabel: "2021 effective text",
        sourceReference: "Official legislative publication",
        content: authorityText,
        effectiveFrom: "2021-01-01",
        effectiveTo: null,
      }),
    );
    await repository.verifyLitigationLegalAuthorityVersion(
      ctx,
      matterId,
      authority.id,
      {
        comment:
          "Counsel compared the stored provision, identifier and effective date with the named official publication.",
      },
    );
    await repository.linkLitigationPositionAuthority(ctx, matterId, {
      claimId: claim.id,
      authorityVersionId: authority.id,
      applicabilityDate: "2026-09-01",
      provisionReference: "Article 509",
      exactQuote: "requires each party to perform its obligations as agreed",
      rationale:
        "The provision directly supports applying the agreed performance date to the pleaded defense.",
    });
    const event = record(
      await repository.createLitigationProceduralEvent(ctx, matterId, {
        eventType: "hearing_notice",
        title: "Hearing listed",
        occurredAt: "2026-10-10T09:00:00+08:00",
        createdBy: "human",
        source: {
          sourceChunkId: chunk.id,
          quoteStart: hearingStart,
          quoteEnd: hearingStart + hearingQuote.length,
        },
      }),
    );
    await repository.decideLitigationProceduralEvent(
      ctx,
      matterId,
      event.id,
      {
        decision: "confirmed",
        comment: "Counsel verified the hearing listing against the notice.",
      },
    );

    for (const kind of [
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
    ] as const) {
      const artifact = record(
        await repository.generateLitigationArtifact(ctx, matterId, kind),
      );
      assert.deepEqual(artifact.validation_errors, []);
      assert.equal(artifact.stale_at, null);
    }

    const preview = record(
      await repository.getLitigationMatterAuditExportPreview(ctx, matterId),
    );
    assert.equal(
      preview.checklist.overall_status,
      "ready",
      JSON.stringify(preview.checklist, null, 2),
    );
    assert.match(preview.matter_state_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(preview.checklist_hash, /^sha256:[a-f0-9]{64}$/);
    await assert.rejects(
      repository.requestApproval(ctx, matterId, {
        action: "litigation_matter_audit_export",
        requestedPayload: {
          matterStateHash: "sha256:" + "0".repeat(64),
          checklistHash: preview.checklist_hash,
          checklistSchemaVersion: preview.checklist.schema_version,
        },
      }),
      /must bind the current matter state/i,
    );
    const checkpoint = record(
      await repository.requestApproval(ctx, matterId, {
        action: "litigation_matter_audit_export",
        prompt: "Approve the exact litigation matter audit snapshot.",
        requestedPayload: {
          matterStateHash: preview.matter_state_hash,
          checklistHash: preview.checklist_hash,
          checklistSchemaVersion: preview.checklist.schema_version,
        },
      }),
    );
    await repository.decideApproval(ctx, matterId, checkpoint.id, {
      decision: "approved",
      comment: "Counsel approved export of this exact audit snapshot.",
    });
    const exportDirectory = path.join(dataDir, "exports", matterId);
    const filesBeforeFailure = existsSync(exportDirectory)
      ? readdirSync(exportDirectory).sort()
      : [];
    const failureDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    try {
      failureDb.exec(`
        create trigger fail_litigation_audit_export_insert
        before insert on aletheia_exports
        when new.export_type = 'litigation_matter_audit_package'
        begin
          select raise(abort, 'forced audit package persistence failure');
        end;
      `);
    } finally {
      failureDb.close();
    }
    await assert.rejects(
      repository.createLitigationMatterAuditExport(ctx, matterId, {
        approvalCheckpointId: checkpoint.id,
      }),
      /forced audit package persistence failure/i,
    );
    assert.deepEqual(
      existsSync(exportDirectory) ? readdirSync(exportDirectory).sort() : [],
      filesBeforeFailure,
      "failed database persistence must not leave an orphan package file",
    );
    const recoveryDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    try {
      recoveryDb.exec("drop trigger fail_litigation_audit_export_insert");
    } finally {
      recoveryDb.close();
    }
    const exported = record(
      await repository.createLitigationMatterAuditExport(ctx, matterId, {
        approvalCheckpointId: checkpoint.id,
      }),
    );
    assert.equal(exported.matter_state_hash, preview.matter_state_hash);
    assert.equal(exported.checklist_hash, preview.checklist_hash);
    assert.equal(exported.snapshot.litigation.claims.length, 1);
    assert.equal(exported.snapshot.artifacts.length, 5);
    assert.match(
      exported.snapshot.source_manifest.documents[0].original_file_sha256,
      /^[a-f0-9]{64}$/,
    );
    assert.match(
      exported.snapshot.source_manifest.chunks[0].text_snapshot_hash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal("storage_path" in JSON.parse(JSON.stringify(exported)), false);

    const loaded = record(
      await repository.getLitigationMatterAuditExport(
        ctx,
        matterId,
        exported.export_id,
      ),
    );
    assert.equal(loaded.export_hash, exported.export_hash);
    assert.equal(
      (
        (await repository.listLitigationMatterAuditExports(
          ctx,
          matterId,
        )) as Array<Record<string, any>>
      )[0].stale,
      false,
    );

    assert.throws(
      () => runAuditAnchorRuntimeNow("disabled_probe"),
      AuditAnchorConfigurationError,
    );
    mkdirSync(anchorDir, { mode: 0o700 });
    mkdirSync(keyDir, { mode: 0o700 });
    const privateKeyPath = path.join(keyDir, "anchor-private.pem");
    const publicKeyPath = path.join(keyDir, "anchor-public.pem");
    generateAuditAnchorKeyPair({
      dataDir,
      privateKeyPath,
      publicKeyPath,
    });
    process.env.ALETHEIA_AUDIT_ANCHOR_ENABLED = "true";
    process.env.ALETHEIA_AUDIT_ANCHOR_DIR = anchorDir;
    process.env.ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE = privateKeyPath;
    process.env.ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE = publicKeyPath;
    anchorRuntime = startAuditAnchorRuntimeFromEnvironment();
    assert(anchorRuntime);

    await assert.rejects(
      repository.signLitigationMatterAuditExport(
        ctx,
        matterId,
        exported.export_id,
        {
          exportHash: exported.export_hash,
          checklistHash: exported.checklist_hash,
          matterStateHash: exported.matter_state_hash,
          signerName: "Counsel Li",
          professionalIdentifier: "Synthetic-001",
          attestation: preview.attestation,
          comment: "too short",
        },
      ),
      /at least 20 characters/i,
    );
    const signoff = record(
      await repository.signLitigationMatterAuditExport(
        ctx,
        matterId,
        exported.export_id,
        {
          exportHash: exported.export_hash,
          checklistHash: exported.checklist_hash,
          matterStateHash: exported.matter_state_hash,
          signerName: "Counsel Li",
          professionalIdentifier: "Synthetic-001",
          attestation: preview.attestation,
          comment:
            "I reviewed every readiness item and the exact package hashes before recording this sign-off.",
        },
      ),
    );
    assert.equal(signoff.integrity_valid, true);
    assert.equal(signoff.audit_binding_valid, true);
    assert.match(signoff.auditEventHash, /^hmac-sha256:[a-f0-9]{64}$/);
    assert.equal(signoff.stale, false);
    assert.equal(signoff.independentReview, false);
    const anchorTarget = record(
      await repository.authorizeLitigationMatterAuditSignoffAnchor(
        ctx,
        matterId,
        exported.export_id,
        signoff.id,
      ),
    );
    assert.equal(anchorTarget.exactCurrentMatterHead, true);
    const anchorEntry = runAuditAnchorRuntimeNow(
      `litigation_signoff:${signoff.id}`,
    );
    const coverage = findExactMatterAuditAnchorCoverage({
      dataDir,
      anchorDir,
      publicKeyPath,
      matterId,
      eventSequence: signoff.auditEventSequence,
      eventHash: signoff.auditEventHash,
    });
    assert(coverage);
    assert.equal(coverage.anchor_id, anchorEntry.anchor_id);
    assert.equal(coverage.coverage, "exact_matter_audit_head");
    assert.equal(
      findExactMatterAuditAnchorCoverage({
        dataDir,
        anchorDir,
        publicKeyPath,
        matterId,
        eventSequence: signoff.auditEventSequence,
        eventHash: "hmac-sha256:wrong-event-hash",
      }),
      null,
    );
    await assert.rejects(
      repository.signLitigationMatterAuditExport(
        ctx,
        matterId,
        exported.export_id,
        {
          exportHash: exported.export_hash,
          checklistHash: exported.checklist_hash,
          matterStateHash: exported.matter_state_hash,
          signerName: "Counsel Li",
          professionalIdentifier: "Synthetic-001",
          attestation: preview.attestation,
          comment:
            "A duplicate sign-off for the same package and checklist must be rejected.",
        },
      ),
      /UNIQUE constraint failed/i,
    );
    await assert.rejects(
      repository.getLitigationMatterAuditExport(
        { userId: "other-user" },
        matterId,
        exported.export_id,
      ),
      /permission|access|forbidden|lacks/i,
    );

    await repository.createLitigationFact(ctx, matterId, {
      statement: "A later proposed fact changes the current matter snapshot.",
      occurredAt: null,
      datePrecision: "unknown",
      helpfulness: "unknown",
      confidence: "low",
      createdBy: "human",
    });
    const signoffs = (await repository.listLitigationMatterAuditExportSignoffs(
      ctx,
      matterId,
      exported.export_id,
    )) as Array<Record<string, any>>;
    assert.equal(signoffs.length, 1);
    assert.equal(signoffs[0].integrity_valid, true);
    assert.equal(signoffs[0].stale, true);
    const advancedTarget = record(
      await repository.authorizeLitigationMatterAuditSignoffAnchor(
        ctx,
        matterId,
        exported.export_id,
        signoff.id,
      ),
    );
    assert.equal(advancedTarget.exactCurrentMatterHead, false);
    assert(
      findExactMatterAuditAnchorCoverage({
        dataDir,
        anchorDir,
        publicKeyPath,
        matterId,
        eventSequence: signoff.auditEventSequence,
        eventHash: signoff.auditEventHash,
      }),
    );
    await assert.rejects(
      repository.signLitigationMatterAuditExport(
        ctx,
        matterId,
        exported.export_id,
        {
          exportHash: exported.export_hash,
          checklistHash: exported.checklist_hash,
          matterStateHash: exported.matter_state_hash,
          signerName: "Counsel Li",
          professionalIdentifier: null,
          attestation: preview.attestation,
          comment:
            "A stale historical package must not receive a new counsel sign-off.",
        },
      ),
      /stale|hashes differ/i,
    );

    const chainTamperDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    chainTamperDb
      .prepare("update aletheia_audit_events set event_hash = ? where id = ?")
      .run("hmac-sha256:tampered", signoff.auditEventId);
    chainTamperDb.close();
    await assert.rejects(
      repository.getLitigationMatterAuditSignoffAnchorTarget(
        ctx,
        matterId,
        exported.export_id,
        signoff.id,
      ),
      /audit-event binding|audit-chain integrity/i,
    );
    const chainRestoreDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    chainRestoreDb
      .prepare("update aletheia_audit_events set event_hash = ? where id = ?")
      .run(signoff.auditEventHash, signoff.auditEventId);
    chainRestoreDb.close();

    const db = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    let exportPath: string;
    try {
      const row = db
        .prepare("select export_path from aletheia_exports where id = ?")
        .get(exported.export_id) as { export_path: string };
      exportPath = row.export_path;
      assert.throws(
        () =>
          db
            .prepare(
              "update aletheia_litigation_audit_export_signoffs set comment = ? where id = ?",
            )
            .run("tampered", signoff.id),
        /immutable/i,
      );
    } finally {
      db.close();
    }
    const originalBytes = readFileSync(exportPath);
    writeFileSync(exportPath, Buffer.from("{\"tampered\":true}"));
    await assert.rejects(
      repository.getLitigationMatterAuditExport(
        ctx,
        matterId,
        exported.export_id,
      ),
      /hash verification|cannot be decrypted or parsed/i,
    );
    writeFileSync(exportPath, originalBytes);

    const auditActions = record(
      await repository.getMatterDetail(ctx, matterId),
    ).auditEvents.map((item: Record<string, any>) => item.action);
    assert(auditActions.includes("litigation_matter_audit_package_exported"));
    assert(
      auditActions.includes("litigation_matter_audit_package_signed_off"),
    );
    const integrity = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "src/scripts/aletheiaAuditIntegrity.ts"],
      {
        cwd: path.resolve(process.cwd()),
        env: {
          ...process.env,
          ALETHEIA_AUDIT_SOURCE_DIR: dataDir,
        },
        encoding: "utf8",
      },
    );
    assert.equal(integrity.status, 0, integrity.stderr || integrity.stdout);
    const integrityResult = JSON.parse(integrity.stdout) as Record<string, any>;
    assert.equal(integrityResult.ok, true);
    assert.equal(integrityResult.summary.litigationMatterAuditExports, 1);
    assert.equal(integrityResult.summary.litigationMatterAuditSignoffs, 1);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-litigation-matter-audit-package-v1",
          checks: [
            "complete litigation snapshot and per-section hashes",
            "server-derived readiness checklist",
            "exact state/checklist approval binding",
            "protected package persistence and reload",
            "database rollback removes orphan package files",
            "immutable counsel sign-off receipt",
            "exact Ed25519 operator anchor coverage",
            "disabled and advanced-head anchor failure",
            "tampered HMAC chain blocks anchor proof",
            "historical sign-off staleness after matter change",
            "cross-user and duplicate rejection",
            "package and sign-off tamper failure",
            "matter HMAC audit events",
            "global audit-integrity linkage",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    anchorRuntime?.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(anchorDir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[vera-litigation-matter-audit-package] failed", error);
  process.exitCode = 1;
});
