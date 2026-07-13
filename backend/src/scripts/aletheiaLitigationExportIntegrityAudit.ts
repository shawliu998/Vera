import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

function asRecord(value: unknown) {
  return value as Record<string, any>;
}

function runIntegrityAudit(dataDir: string) {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "src/scripts/aletheiaAuditIntegrity.ts"],
    {
      cwd: path.resolve(process.cwd()),
      env: {
        ...process.env,
        ALETHEIA_AUTH_MODE: "single_user",
        ALETHEIA_AUDIT_SOURCE_DIR: dataDir,
      },
      encoding: "utf8",
    },
  );
  const output = JSON.parse(result.stdout) as Record<string, any>;
  return { ...result, output };
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-litigation-export-audit-"),
  );
  const dataDir = path.join(root, "vault");
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  const { createAletheiaRepository } = await import("../lib/aletheia");
  const repository = createAletheiaRepository();
  let retainedExportPath: string | null = null;
  const ctx = {
    userId: "litigation-export-auditor",
    userEmail: "litigation-export-auditor@aletheia.invalid",
  };

  try {
    const matter = asRecord(
      await repository.createMatter(ctx, {
        title: "Litigation export integrity audit",
        objective: "Verify exact approval and audit binding for an export.",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: "Regression fixture",
        sourceProjectId: null,
        sharedWith: [],
        metadata: { regression: true },
      }),
    );
    const matterId = String(matter.id);
    const document = Buffer.from(
      "The signed agreement states that payment is due on 1 September 2026.",
      "utf8",
    );
    await repository.uploadMatterDocument(ctx, matterId, {
      filename: "agreement.txt",
      mimeType: "text/plain",
      sizeBytes: document.length,
      buffer: document,
    });
    const sourceIndex = asRecord(
      await repository.listV1SourceIndex(ctx, matterId, {
        includeChunks: true,
        includeEvidenceLinks: true,
        chunkLimit: 20,
      }),
    );
    const chunk = asRecord(sourceIndex.chunks?.[0]);
    const quote = "payment is due on 1 September 2026";
    const quoteStart = String(chunk.text).indexOf(quote);
    assert(quoteStart >= 0, "Regression quote must survive document parsing");
    const fact = asRecord(
      await repository.createLitigationFact(ctx, matterId, {
        statement: "Payment is due on 1 September 2026.",
        occurredAt: "2026-09-01T00:00:00+08:00",
        datePrecision: "day",
        helpfulness: "helpful",
        confidence: "high",
        createdBy: "agent",
        sourceRelation: "supports",
        source: {
          sourceChunkId: String(chunk.id),
          quoteStart,
          quoteEnd: quoteStart + quote.length,
        },
      }),
    );
    await repository.decideLitigationFact(ctx, matterId, String(fact.id), {
      decision: "confirmed",
      comment: "Verified by the regression reviewer.",
    });
    const artifact = asRecord(
      await repository.generateLitigationArtifact(
        ctx,
        matterId,
        "evidence_catalog",
      ),
    );
    const requestedPayload = {
      workProductId: String(artifact.id),
      version: Number(artifact.version),
      contentHash: String(artifact.content_hash),
    };
    const checkpoint = asRecord(
      await repository.requestApproval(ctx, matterId, {
        action: "litigation_artifact_export",
        prompt: "Approve the exact evidence catalog version for export.",
        requestedPayload,
      }),
    );
    await repository.decideApproval(ctx, matterId, String(checkpoint.id), {
      decision: "approved",
      comment: "Approved by the responsible lawyer.",
    });
    const exported = asRecord(
      await repository.exportLitigationArtifact(
        ctx,
        matterId,
        String(artifact.id),
        String(checkpoint.id),
      ),
    );
    retainedExportPath = String(exported.exportPath);
    assert.equal(exported.workProductId, artifact.id);
    assert.equal(exported.contentHash, artifact.content_hash);
    assert.equal(exported.format, "docx");
    assert.match(exported.exportPath, /\.docx$/);
    const exportedBytes = readFileSync(exported.exportPath);
    assert.equal(exportedBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(
      exported.exportHash,
      `sha256:${createHash("sha256").update(exportedBytes).digest("hex")}`,
    );

    const valid = runIntegrityAudit(dataDir);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    assert.equal(valid.output.ok, true);
    assert.equal(valid.output.summary.litigationArtifactExports, 1);
    assert.equal(valid.output.summary.highRiskExports, 1);

    const uncitedClaim = asRecord(
      await repository.createLitigationClaim(ctx, matterId, {
        kind: "claim",
        title: "An uncited legal position must not reach final export.",
        legalBasis: "Unverified authority",
        confidence: "low",
        uncertainty: "The authority has not been added to the matter record.",
        createdBy: "agent",
      }),
    );
    await repository.decideLitigationClaim(
      ctx,
      matterId,
      String(uncitedClaim.id),
      { decision: "confirmed", comment: "Regression fixture." },
    );
    const uncitedArtifact = asRecord(
      await repository.generateLitigationArtifact(
        ctx,
        matterId,
        "litigation_brief",
      ),
    );
    const uncitedCheckpoint = asRecord(
      await repository.requestApproval(ctx, matterId, {
        action: "litigation_artifact_export",
        prompt: "Attempt an uncited legal-position export.",
        requestedPayload: {
          workProductId: uncitedArtifact.id,
          version: uncitedArtifact.version,
          contentHash: uncitedArtifact.content_hash,
        },
      }),
    );
    await repository.decideApproval(
      ctx,
      matterId,
      String(uncitedCheckpoint.id),
      { decision: "approved", comment: "Approval cannot bypass source gates." },
    );
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          ctx,
          matterId,
          String(uncitedArtifact.id),
          String(uncitedCheckpoint.id),
        ),
      /exact source citation/,
    );

    const openReview = asRecord(
      await repository.createPositionReview(
        ctx,
        matterId,
        String(uncitedClaim.id),
        {
          kind: "objection",
          reason: "The legal basis is not supported by a retained authority.",
          requestedOutcome: "rejected",
        },
      ),
    );
    const reviewArtifact = asRecord(
      await repository.generateLitigationArtifact(
        ctx,
        matterId,
        "litigation_brief",
      ),
    );
    const reviewCheckpoint = asRecord(
      await repository.requestApproval(ctx, matterId, {
        action: "litigation_artifact_export",
        prompt: "Attempt an export during open review.",
        requestedPayload: {
          workProductId: reviewArtifact.id,
          version: reviewArtifact.version,
          contentHash: reviewArtifact.content_hash,
        },
      }),
    );
    await repository.decideApproval(
      ctx,
      matterId,
      String(reviewCheckpoint.id),
      {
        decision: "approved",
        comment: "Approval cannot bypass an open review.",
      },
    );
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          ctx,
          matterId,
          String(reviewArtifact.id),
          String(reviewCheckpoint.id),
        ),
      /position review is open/,
    );
    await repository.resolvePositionReview(
      ctx,
      matterId,
      String(openReview.id),
      { resolution: "granted", comment: "Uncited position rejected." },
    );

    const citedClaim = asRecord(
      await repository.createLitigationClaim(ctx, matterId, {
        kind: "defense",
        title: "A cited position with an unresolved element gap.",
        legalBasis: "Signed agreement",
        confidence: "medium",
        uncertainty: "Factual support for one element is incomplete.",
        sourceRelation: "supports",
        source: {
          sourceChunkId: String(chunk.id),
          quoteStart,
          quoteEnd: quoteStart + quote.length,
        },
        createdBy: "agent",
      }),
    );
    await repository.decideLitigationClaim(
      ctx,
      matterId,
      String(citedClaim.id),
      {
        decision: "confirmed",
        comment: "Regression fixture.",
      },
    );
    const exportAuthorityQuote =
      "A signed agreement must be performed according to its verified terms.";
    const exportAuthority = asRecord(
      await repository.createLitigationLegalAuthorityVersion(ctx, matterId, {
        authorityType: "regulation",
        title: "Verified agreement performance rule",
        issuer: "Verified rulemaking authority",
        officialIdentifier: "EXPORT-INTEGRITY-RULE-2026",
        versionLabel: "2026 official copy",
        sourceReference: "Named official publication",
        content: `${exportAuthorityQuote} This version is effective in 2026.`,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      }),
    );
    await repository.verifyLitigationLegalAuthorityVersion(
      ctx,
      matterId,
      String(exportAuthority.id),
      { comment: "Counsel checked the exact source and effective interval." },
    );
    await repository.linkLitigationPositionAuthority(ctx, matterId, {
      claimId: citedClaim.id,
      authorityVersionId: exportAuthority.id,
      applicabilityDate: "2026-07-01",
      provisionReference: "Agreement performance",
      exactQuote: exportAuthorityQuote,
      rationale: "The verified rule governs the cited agreement position.",
    });
    const gapElement = asRecord(
      await repository.createLitigationElement(
        ctx,
        matterId,
        String(citedClaim.id),
        { title: "Unresolved performance element", sequence: 1 },
      ),
    );
    await repository.decideLitigationElement(
      ctx,
      matterId,
      String(gapElement.id),
      { decision: "confirmed", comment: "Gap retained for export test." },
    );
    const gapArtifact = asRecord(
      await repository.generateLitigationArtifact(
        ctx,
        matterId,
        "litigation_brief",
      ),
    );
    const gapCheckpoint = asRecord(
      await repository.requestApproval(ctx, matterId, {
        action: "litigation_artifact_export",
        prompt: "Attempt an export with unresolved validation errors.",
        requestedPayload: {
          workProductId: gapArtifact.id,
          version: gapArtifact.version,
          contentHash: gapArtifact.content_hash,
        },
      }),
    );
    await repository.decideApproval(ctx, matterId, String(gapCheckpoint.id), {
      decision: "approved",
      comment: "Approval cannot bypass validation errors.",
    });
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          ctx,
          matterId,
          String(gapArtifact.id),
          String(gapCheckpoint.id),
        ),
      /validation errors/,
    );

    const db = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    db.prepare(
      "update aletheia_exports set approval_checkpoint_id = null where id = ?",
    ).run(exported.exportId);
    db.close();

    const tampered = runIntegrityAudit(dataDir);
    assert.notEqual(tampered.status, 0);
    assert.equal(tampered.output.ok, false);
    const approvalCheck = tampered.output.checks.find(
      (item: Record<string, unknown>) =>
        item.id === "high-risk-exports-have-approved-checkpoints",
    );
    assert.equal(approvalCheck?.ok, false);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-litigation-export-integrity-v2",
          checks: [
            "exact artifact version and content hash approval binding",
            "approved litigation export persists file and audit event",
            "exported file is a valid OOXML DOCX container",
            "populated audit integrity accepts valid export",
            "uncited legal position export fails closed",
            "open position review export fails closed",
            "validation-error export fails closed",
            "tampered approval checkpoint link fails closed",
          ],
          retainedExportPath:
            process.env.ALETHEIA_KEEP_LITIGATION_EXPORT_AUDIT === "true"
              ? retainedExportPath
              : null,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (process.env.ALETHEIA_KEEP_LITIGATION_EXPORT_AUDIT !== "true") {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
