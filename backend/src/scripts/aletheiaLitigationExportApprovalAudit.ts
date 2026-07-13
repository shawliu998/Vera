import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  GovernancePolicyError,
  LocalGovernanceService,
} from "../lib/aletheia/localGovernance";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";

type Row = Record<string, any>;

function row(value: unknown) {
  return value as Row;
}

function artifactBinding(artifact: Row) {
  return {
    workProductId: String(artifact.id),
    version: Number(artifact.version),
    contentHash: String(artifact.content_hash),
  };
}

async function expectGovernanceError(
  code: GovernancePolicyError["code"],
  status: number,
  operation: () => unknown | Promise<unknown>,
) {
  await assert.rejects(
    async () => operation(),
    (error: unknown) => {
      assert.ok(error instanceof GovernancePolicyError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    },
  );
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-litigation-export-approval-"),
  );
  const databasePath = path.join(root, "aletheia.db");
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const repository = new LocalAletheiaRepository();
  const owner = { userId: "export-owner" };
  const counsel = { userId: "shared-counsel" };
  const reviewerOne = { userId: "reviewer-one" };
  const reviewerTwo = { userId: "reviewer-two" };
  const auditor = { userId: "export-auditor" };
  const governance = new LocalGovernanceService({
    databasePath,
    multiPrincipalEnabled: true,
  });

  const createMatter = async (title: string) =>
    row(
      await repository.createMatter(owner, {
        title,
        objective: "Audit governed litigation artifact export.",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: "Governance audit",
        sourceProjectId: null,
        sharedWith: [],
        metadata: { audit: "litigation_export_approval" },
      }),
    );

  try {
    const matter = await createMatter("Governed litigation export");
    governance.governance(owner.userId, matter.id);
    for (const principal of [
      [counsel.userId, "Shared Counsel", "counsel"],
      [reviewerOne.userId, "Reviewer One", "reviewer"],
      [reviewerTwo.userId, "Reviewer Two", "reviewer"],
      [auditor.userId, "Export Auditor", "auditor"],
    ] as const) {
      governance.createPrincipal(owner.userId, {
        id: principal[0],
        displayName: principal[1],
        roles: [principal[2]],
      });
      governance.setMatterAcl(
        owner.userId,
        matter.id,
        principal[0],
        principal[2],
      );
    }

    const noPolicyMatter = await createMatter("Missing policy fails closed");
    governance.governance(owner.userId, noPolicyMatter.id);
    governance.setMatterAcl(
      owner.userId,
      noPolicyMatter.id,
      counsel.userId,
      "counsel",
    );
    const noPolicyArtifact = row(
      await repository.generateLitigationArtifact(
        owner,
        noPolicyMatter.id,
        "hearing_plan",
      ),
    );
    await expectGovernanceError("POLICY_DISABLED", 409, () =>
      repository.requestApproval(counsel, noPolicyMatter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(noPolicyArtifact),
      }),
    );

    governance.setApprovalPolicy(owner.userId, matter.id, {
      action: "litigation_artifact_export",
      requiredApprovals: 2,
      eligibleRoles: ["reviewer", "auditor"],
      requireDistinctRoles: true,
      prohibitRequester: true,
      enabled: true,
    });
    const artifact = row(
      await repository.generateLitigationArtifact(
        owner,
        matter.id,
        "hearing_plan",
      ),
    );
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.requestApproval(reviewerOne, matter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(artifact),
      }),
    );

    const checkpoint = row(
      await repository.requestApproval(counsel, matter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(artifact),
      }),
    );
    const idempotent = row(
      await repository.requestApproval(counsel, matter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(artifact),
      }),
    );
    assert.equal(idempotent.id, checkpoint.id);
    assert.equal(
      idempotent.requested_payload.governanceApprovalRequestId,
      checkpoint.requested_payload.governanceApprovalRequestId,
    );
    assert.equal(checkpoint.user_id, owner.userId);
    assert.equal(checkpoint.requested_payload.matterId, matter.id);
    assert.equal(checkpoint.requested_payload.requesterId, counsel.userId);
    const requesterProjection = row(
      await repository.getLitigationArtifactExportApproval(
        counsel,
        matter.id,
        artifact.id,
      ),
    );
    assert.equal(requesterProjection.governanceRequest.approvedVotes, 0);
    assert.equal(requesterProjection.governanceRequest.requiredApprovals, 2);
    assert.equal(requesterProjection.actor.canVote, false);
    assert.equal(
      requesterProjection.actor.voteBlockReason,
      "requester_cannot_vote",
    );
    assert.equal(requesterProjection.actor.canExport, true);
    const reopenedByReviewer = row(
      await repository.getLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        artifact.id,
      ),
    );
    assert.equal(reopenedByReviewer.approvalCheckpointId, checkpoint.id);
    assert.equal(reopenedByReviewer.governanceRequest.approvedVotes, 0);
    assert.equal(reopenedByReviewer.actor.canVote, true);
    assert.equal(reopenedByReviewer.actor.canExport, false);

    const nextArtifact = row(
      await repository.generateLitigationArtifact(
        owner,
        matter.id,
        "hearing_plan",
      ),
    );
    const conflicting = row(
      await repository.requestApproval(counsel, matter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(nextArtifact),
      }),
    );
    assert.notEqual(conflicting.id, checkpoint.id);
    assert.notEqual(
      conflicting.requested_payload.governanceApprovalRequestId,
      checkpoint.requested_payload.governanceApprovalRequestId,
    );
    const rejectedCheckpoint = row(
      await repository.voteLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        nextArtifact.id,
        {
          approvalCheckpointId: conflicting.id,
          decision: "rejected",
          comment: "Conflicting artifact export is rejected.",
        },
      ),
    );
    assert.equal(rejectedCheckpoint.checkpointStatus, "rejected");
    assert.equal(rejectedCheckpoint.governanceRequest.status, "rejected");

    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.voteLitigationArtifactExportApproval(
        counsel,
        matter.id,
        artifact.id,
        {
          approvalCheckpointId: checkpoint.id,
          decision: "approved",
          comment: "Requester self-approval must fail.",
        },
      ),
    );
    const afterFirstVote = row(
      await repository.voteLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        artifact.id,
        {
          approvalCheckpointId: checkpoint.id,
          decision: "approved",
          comment: "First independent review vote.",
        },
      ),
    );
    assert.equal(afterFirstVote.checkpointStatus, "open");
    assert.equal(afterFirstVote.governanceRequest.approvedVotes, 1);
    assert.equal(afterFirstVote.governanceRequest.requiredApprovals, 2);
    assert.equal(afterFirstVote.governanceRequest.status, "pending");
    assert.equal(afterFirstVote.actor.canVote, false);
    assert.equal(afterFirstVote.actor.voteBlockReason, "actor_already_voted");
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.voteLitigationArtifactExportApproval(
        reviewerTwo,
        matter.id,
        artifact.id,
        {
          approvalCheckpointId: checkpoint.id,
          decision: "approved",
          comment: "A duplicate reviewer role must not satisfy distinct roles.",
        },
      ),
    );
    const approvedCheckpoint = row(
      await repository.voteLitigationArtifactExportApproval(
        auditor,
        matter.id,
        artifact.id,
        {
          approvalCheckpointId: checkpoint.id,
          decision: "approved",
          comment: "Second vote from the distinct auditor role.",
        },
      ),
    );
    assert.equal(approvedCheckpoint.checkpointStatus, "approved");
    assert.equal(approvedCheckpoint.governanceRequest.approvedVotes, 2);
    assert.equal(approvedCheckpoint.governanceRequest.requiredApprovals, 2);
    assert.equal(approvedCheckpoint.governanceRequest.status, "approved");
    assert.deepEqual(approvedCheckpoint.independentApproval.approvedBy, [
      reviewerOne.userId,
      auditor.userId,
    ]);

    const exported = row(
      await repository.exportLitigationArtifact(
        counsel,
        matter.id,
        artifact.id,
        checkpoint.id,
        "docx",
      ),
    );
    assert.equal(exported.exportedBy, counsel.userId);
    const exportedProjection = row(
      await repository.getLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        artifact.id,
      ),
    );
    assert.equal(exportedProjection.export.status, "exported");
    assert.equal(exportedProjection.export.exportId, exported.exportId);
    assert.equal(exportedProjection.export.exportedBy, counsel.userId);
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.exportLitigationArtifact(
        reviewerOne,
        matter.id,
        artifact.id,
        checkpoint.id,
      ),
    );
    const download = await repository.downloadLitigationArtifact(
      counsel,
      matter.id,
      exported.exportId,
    );
    assert(download);
    assert.equal(download.bytes.subarray(0, 2).toString("ascii"), "PK");
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.downloadLitigationArtifact(
        reviewerOne,
        matter.id,
        exported.exportId,
      ),
    );

    const database = new LocalDatabase(databasePath);
    const exportRecord = database
      .prepare("select * from aletheia_exports where id = ?")
      .get(exported.exportId) as Row;
    assert.equal(exportRecord.user_id, owner.userId);
    const exportAudit = database
      .prepare(
        `select * from aletheia_audit_events
          where matter_id = ? and action = 'litigation_artifact_exported'
          order by sequence desc limit 1`,
      )
      .get(matter.id) as Row;
    const exportAuditDetails = JSON.parse(String(exportAudit.details));
    assert.equal(exportAudit.user_id, owner.userId);
    assert.equal(exportAuditDetails.ownerId, owner.userId);
    assert.equal(exportAuditDetails.actorId, counsel.userId);
    assert.equal(exportAuditDetails.requesterId, counsel.userId);
    assert.equal(
      exportAuditDetails.governanceApprovalRequestId,
      checkpoint.requested_payload.governanceApprovalRequestId,
    );
    assert.equal(exportAuditDetails.governanceApprovedVotes, 2);
    const approvalAudit = database
      .prepare(
        `select * from aletheia_audit_events
          where matter_id = ? and action = 'approval_approved'
          order by sequence desc limit 1`,
      )
      .get(matter.id) as Row;
    const approvalAuditDetails = JSON.parse(String(approvalAudit.details));
    assert.equal(approvalAudit.user_id, owner.userId);
    assert.equal(approvalAuditDetails.ownerId, owner.userId);
    assert.equal(approvalAuditDetails.requesterId, counsel.userId);
    assert.equal(approvalAuditDetails.voterId, auditor.userId);
    assert.equal(
      approvalAuditDetails.governanceApprovalRequestId,
      checkpoint.requested_payload.governanceApprovalRequestId,
    );
    assert.equal(approvalAuditDetails.approvedVotes, 2);
    assert.equal(approvalAuditDetails.governanceStatus, "approved");

    const originalVersion = artifact.version;
    database
      .prepare("update aletheia_work_products set version = ? where id = ?")
      .run(Number(originalVersion) + 100, artifact.id);
    const staleVersionProjection = row(
      await repository.getLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        artifact.id,
      ),
    );
    assert.equal(staleVersionProjection.checkpointStatus, "stale");
    assert.equal(
      staleVersionProjection.actor.voteBlockReason,
      "artifact_binding_stale",
    );
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          counsel,
          matter.id,
          artifact.id,
          checkpoint.id,
        ),
      /not bound to this artifact version/,
    );
    database
      .prepare("update aletheia_work_products set version = ? where id = ?")
      .run(originalVersion, artifact.id);

    const originalContent = database
      .prepare("select content from aletheia_work_products where id = ?")
      .get(artifact.id) as { content: string };
    database
      .prepare("update aletheia_work_products set content = ? where id = ?")
      .run(JSON.stringify({ tampered: true }), artifact.id);
    const invalidContentProjection = row(
      await repository.getLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        artifact.id,
      ),
    );
    assert.equal(invalidContentProjection.checkpointStatus, "ineligible");
    assert.equal(
      invalidContentProjection.actor.voteBlockReason,
      "artifact_ineligible",
    );
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          counsel,
          matter.id,
          artifact.id,
          checkpoint.id,
        ),
      /content hash is invalid/,
    );
    database
      .prepare("update aletheia_work_products set content = ? where id = ?")
      .run(originalContent.content, artifact.id);

    const event = row(
      await repository.createLitigationProceduralEvent(owner, matter.id, {
        eventType: "hearing",
        title: "New hearing changes the approved artifact state",
        occurredAt: "2026-08-01T09:00:00+08:00",
        createdBy: "human",
      }),
    );
    await repository.decideLitigationProceduralEvent(
      owner,
      matter.id,
      event.id,
      { decision: "confirmed", comment: "Confirmed state change." },
    );
    const staleStateProjection = row(
      await repository.getLitigationArtifactExportApproval(
        reviewerOne,
        matter.id,
        artifact.id,
      ),
    );
    assert.equal(staleStateProjection.checkpointStatus, "stale");
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          counsel,
          matter.id,
          artifact.id,
          checkpoint.id,
        ),
      /stale|dependencies changed/,
    );

    database
      .prepare(
        "delete from aletheia_matter_acl where matter_id = ? and principal_id = ?",
      )
      .run(matter.id, counsel.userId);
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.exportLitigationArtifact(
        counsel,
        matter.id,
        artifact.id,
        checkpoint.id,
      ),
    );
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.downloadLitigationArtifact(
        counsel,
        matter.id,
        exported.exportId,
      ),
    );
    await expectGovernanceError("FORBIDDEN", 403, () =>
      repository.getLitigationArtifactExportApproval(
        counsel,
        matter.id,
        artifact.id,
      ),
    );
    database.close();

    const restrictedMatter = await createMatter("Restricted export overlay");
    governance.governance(owner.userId, restrictedMatter.id);
    for (const [principalId, selectedRole] of [
      [counsel.userId, "counsel"],
      [reviewerOne.userId, "reviewer"],
      [auditor.userId, "auditor"],
    ] as const) {
      governance.setMatterAcl(
        owner.userId,
        restrictedMatter.id,
        principalId,
        selectedRole,
      );
    }
    governance.updateGovernance(owner.userId, restrictedMatter.id, {
      classification: "restricted",
    });
    governance.setApprovalPolicy(owner.userId, restrictedMatter.id, {
      action: "litigation_artifact_export",
      requiredApprovals: 1,
      eligibleRoles: ["reviewer"],
      enabled: true,
    });
    governance.setApprovalPolicy(owner.userId, restrictedMatter.id, {
      action: "restricted_export",
      requiredApprovals: 1,
      eligibleRoles: ["auditor"],
      enabled: true,
    });
    const restrictedArtifact = row(
      await repository.generateLitigationArtifact(
        owner,
        restrictedMatter.id,
        "hearing_plan",
      ),
    );
    const restrictedCheckpoint = row(
      await repository.requestApproval(counsel, restrictedMatter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(restrictedArtifact),
      }),
    );
    await repository.decideApproval(
      reviewerOne,
      restrictedMatter.id,
      restrictedCheckpoint.id,
      { decision: "approved", comment: "Artifact approval only." },
    );
    await expectGovernanceError("APPROVAL_REQUIRED", 409, () =>
      repository.exportLitigationArtifact(
        counsel,
        restrictedMatter.id,
        restrictedArtifact.id,
        restrictedCheckpoint.id,
        "docx",
        restrictedCheckpoint.requested_payload.governanceApprovalRequestId,
      ),
    );
    const restrictedRequest = row(
      governance.requestApproval(
        counsel.userId,
        restrictedMatter.id,
        "restricted_export",
        { exportType: "litigation_artifact" },
      ),
    );
    governance.voteApproval(
      auditor.userId,
      restrictedRequest.id,
      "approved",
      "Restricted export approved separately.",
    );
    const restrictedExport = row(
      await repository.exportLitigationArtifact(
        counsel,
        restrictedMatter.id,
        restrictedArtifact.id,
        restrictedCheckpoint.id,
        "docx",
        restrictedRequest.id,
      ),
    );
    assert.equal(
      restrictedExport.exportedBy,
      counsel.userId,
      "Restricted policy must layer on top of artifact approval.",
    );

    process.env.ALETHEIA_AUTH_MODE = "single_user";
    process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "false";
    const singleMatter = await createMatter("Single-user compatibility");
    const singleArtifact = row(
      await repository.generateLitigationArtifact(
        owner,
        singleMatter.id,
        "hearing_plan",
      ),
    );
    const singleCheckpoint = row(
      await repository.requestApproval(owner, singleMatter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding(singleArtifact),
      }),
    );
    assert.equal(
      singleCheckpoint.requested_payload.approvalMode,
      "single_user_non_independent",
    );
    assert.equal(singleCheckpoint.requested_payload.independentApproval, false);
    const singlePendingProjection = row(
      await repository.getLitigationArtifactExportApproval(
        owner,
        singleMatter.id,
        singleArtifact.id,
      ),
    );
    assert.equal(singlePendingProjection.independentApproval.required, false);
    assert.equal(singlePendingProjection.independentApproval.status, "pending");
    assert.equal(singlePendingProjection.governanceRequest, null);
    assert.equal(singlePendingProjection.actor.canVote, false);
    assert.equal(
      singlePendingProjection.actor.voteBlockReason,
      "independent_approval_not_required",
    );
    const singleApproved = row(
      await repository.decideApproval(
        owner,
        singleMatter.id,
        singleCheckpoint.id,
        {
          decision: "approved",
          comment: "Single-user human checkpoint remains supported.",
        },
      ),
    );
    assert.equal(singleApproved.status, "approved");
    assert.equal(singleApproved.decision_payload.independentApproval, false);
    const singleApprovedProjection = row(
      await repository.getLitigationArtifactExportApproval(
        owner,
        singleMatter.id,
        singleArtifact.id,
      ),
    );
    assert.equal(singleApprovedProjection.checkpointStatus, "approved");
    assert.equal(singleApprovedProjection.independentApproval.required, false);
    assert.equal(
      singleApprovedProjection.independentApproval.status,
      "approved",
    );
    assert.deepEqual(singleApprovedProjection.independentApproval.approvedBy, [
      owner.userId,
    ]);
    const singleExport = row(
      await repository.exportLitigationArtifact(
        owner,
        singleMatter.id,
        singleArtifact.id,
        singleCheckpoint.id,
      ),
    );
    assert.equal(singleExport.exportedBy, owner.userId);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-litigation-export-approval-v1",
          checks: [
            "missing policy fails closed",
            "matter.export required to request and export",
            "pending request idempotency and conflicting binding isolation",
            "requester self-vote rejected with 403",
            "first vote keeps checkpoint open",
            "two approvals with distinct roles approve checkpoint",
            "governance rejection rejects checkpoint",
            "shared counsel export and download with owner-scoped persistence",
            "reviewer export and download denied",
            "version, content hash, and confirmed-state changes invalidate approval",
            "ACL revocation blocks export and download",
            "restricted_export remains a separate policy overlay",
            "single-user checkpoint is explicitly non-independent",
            "server projection covers reopen, vote progress, actor blocks, stale state, and export status",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    governance.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-litigation-export-approval-audit] failed", error);
  process.exitCode = 1;
});
