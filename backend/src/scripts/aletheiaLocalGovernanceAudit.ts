import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GovernancePolicyError,
  LocalGovernanceService,
} from "../lib/aletheia/localGovernance";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";

async function expectGovernanceCode(
  code: GovernancePolicyError["code"],
  operation: () => unknown | Promise<unknown>,
) {
  await assert.rejects(
    async () => operation(),
    (error: unknown) => {
      assert.ok(error instanceof GovernancePolicyError);
      assert.equal(error.code, code);
      return true;
    },
  );
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-governance-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const repository = new LocalAletheiaRepository();
  const admin = {
    userId: "governance-admin",
    userEmail: "admin@local.invalid",
  };
  const matterInput = {
    objective: "Govern local privileged evidence",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { governanceTest: true },
  };
  const matterOne = (await repository.createMatter(admin, {
    ...matterInput,
    title: "Governance matter one",
  })) as { id: string };
  const matterTwo = (await repository.createMatter(admin, {
    ...matterInput,
    title: "Governance matter two",
  })) as { id: string };
  const databasePath = path.join(root, "aletheia.db");
  const governance = new LocalGovernanceService({
    databasePath,
    multiPrincipalEnabled: true,
  });

  governance.governance(admin.userId, matterOne.id);
  governance.governance(admin.userId, matterTwo.id);
  governance.createPrincipal(admin.userId, {
    id: "reviewer-one",
    displayName: "Reviewer One",
    roles: ["reviewer"],
  });
  governance.createPrincipal(admin.userId, {
    id: "auditor-two",
    displayName: "Auditor Two",
    roles: ["auditor"],
  });
  governance.setMatterAcl(
    admin.userId,
    matterOne.id,
    "reviewer-one",
    "reviewer",
  );
  governance.setMatterAcl(admin.userId, matterOne.id, "auditor-two", "auditor");

  governance.createPrincipal(admin.userId, {
    id: "counsel-requester",
    displayName: "Counsel Requester",
    roles: ["counsel"],
  });
  const litigationMatter = (await repository.createMatter(admin, {
    ...matterInput,
    title: "Independent litigation review matter",
    template: "civil_litigation",
  })) as { id: string };
  governance.governance(admin.userId, litigationMatter.id);
  governance.setMatterAcl(
    admin.userId,
    litigationMatter.id,
    "counsel-requester",
    "counsel",
  );
  governance.setMatterAcl(
    admin.userId,
    litigationMatter.id,
    "reviewer-one",
    "reviewer",
  );
  assert.equal(
    governance.hasPermission(
      "counsel-requester",
      litigationMatter.id,
      "matter.signoff",
    ),
    true,
  );
  assert.equal(
    governance.hasPermission(
      "reviewer-one",
      litigationMatter.id,
      "matter.signoff",
    ),
    false,
  );
  assert.equal(
    governance.hasPermission(admin.userId, litigationMatter.id, "matter.anchor"),
    true,
  );
  assert.equal(
    governance.hasPermission(
      "counsel-requester",
      litigationMatter.id,
      "matter.anchor",
    ),
    false,
  );
  const claim = (await repository.createLitigationClaim(
    admin,
    litigationMatter.id,
    {
      kind: "defense",
      title: "A position subject to independent ACL review",
      createdBy: "human",
    },
  )) as { id: string };
  await repository.decideLitigationClaim(admin, litigationMatter.id, claim.id, {
    decision: "confirmed",
    comment: "Owner confirms initial assessment.",
  });
  const reviewerContext = { userId: "reviewer-one" };
  const counselContext = { userId: "counsel-requester" };
  const reviewerWorkspace = (await repository.getLitigationWorkspace(
    reviewerContext,
    litigationMatter.id,
  )) as { claims: Array<{ id: string }> };
  assert.equal(reviewerWorkspace.claims[0].id, claim.id);
  const reviewerMatters = (await repository.listMatters(
    reviewerContext,
  )) as Array<{ id: string }>;
  assert.ok(reviewerMatters.some((item) => item.id === litigationMatter.id));
  assert.equal(
    reviewerMatters.some((item) => item.id === matterTwo.id),
    false,
  );
  await expectGovernanceCode("FORBIDDEN", () =>
    repository.createPositionReview(
      reviewerContext,
      litigationMatter.id,
      claim.id,
      {
        kind: "objection",
        reason: "Reviewer role must not create a counsel request.",
        requestedOutcome: "rejected",
      },
    ),
  );
  const governedReview = (await repository.createPositionReview(
    counselContext,
    litigationMatter.id,
    claim.id,
    {
      kind: "objection",
      reason: "Counsel requests independent review.",
      requestedOutcome: "rejected",
    },
  )) as { id: string; user_id: string; created_by: string };
  assert.equal(governedReview.user_id, admin.userId);
  assert.equal(governedReview.created_by, counselContext.userId);
  await assert.rejects(
    () =>
      repository.resolvePositionReview(
        counselContext,
        litigationMatter.id,
        governedReview.id,
        { resolution: "upheld", comment: "Self resolution must fail." },
      ),
    /cannot resolve their own/,
  );
  const governedResolution = (await repository.resolvePositionReview(
    reviewerContext,
    litigationMatter.id,
    governedReview.id,
    { resolution: "upheld", comment: "Independent reviewer upholds." },
  )) as { resolved_by: string; independent_review: number };
  assert.equal(governedResolution.resolved_by, reviewerContext.userId);
  assert.equal(governedResolution.independent_review, 1);

  assert.equal(
    governance.hasPermission("reviewer-one", matterOne.id, "matter.read"),
    true,
  );
  assert.equal(
    governance.hasPermission("reviewer-one", matterTwo.id, "matter.read"),
    false,
  );
  await expectGovernanceCode("FORBIDDEN", () =>
    governance.assertPermission("reviewer-one", matterTwo.id, "matter.read"),
  );
  await expectGovernanceCode("FORBIDDEN", () =>
    governance.assertPermission("reviewer-one", matterOne.id, "matter.write"),
  );

  const purgeCheckpoint = (await repository.requestApproval(
    admin,
    matterOne.id,
    {
      action: "matter_purge",
      requestedPayload: { matterId: matterOne.id },
    },
  )) as { id: string };
  await repository.decideApproval(admin, matterOne.id, purgeCheckpoint.id, {
    decision: "approved",
  });

  governance.updateGovernance(admin.userId, matterOne.id, {
    classification: "privileged",
    legalHold: true,
    legalHoldReason: "Pending litigation",
  });
  await expectGovernanceCode("LEGAL_HOLD", () =>
    repository.purgeMatter(admin, matterOne.id, purgeCheckpoint.id),
  );

  governance.updateGovernance(admin.userId, matterOne.id, {
    legalHold: false,
    retentionDays: 30,
  });
  await expectGovernanceCode("RETENTION_ACTIVE", () =>
    repository.purgeMatter(admin, matterOne.id, purgeCheckpoint.id),
  );

  governance.updateGovernance(admin.userId, matterOne.id, {
    evidenceLocked: true,
    evidenceLockReason: "Evidence set sealed for review",
  });
  await expectGovernanceCode("EVIDENCE_LOCKED", () =>
    repository.uploadMatterDocument(admin, matterOne.id, {
      filename: "locked.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      buffer: Buffer.from("locked"),
      malwareScan: {
        mode: "best_effort",
        status: "clean",
        scanner: "clamav",
        sha256: "0".repeat(64),
        detail: "test fixture",
        scannedAt: new Date().toISOString(),
      },
    }),
  );

  governance.updateGovernance(admin.userId, matterOne.id, {
    evidenceLocked: false,
    retentionDays: null,
    dispositionAt: null,
    classification: "restricted",
  });
  const sensitiveDocument = Buffer.from(
    "PRIVILEGED attorney-client legal advice with passport personal data and bank account details.",
  );
  await repository.uploadMatterDocument(admin, matterOne.id, {
    filename: "privileged-client-data.txt",
    mimeType: "text/plain",
    sizeBytes: 87,
    buffer: sensitiveDocument,
    malwareScan: {
      mode: "best_effort",
      status: "clean",
      scanner: "clamav",
      sha256: createHash("sha256").update(sensitiveDocument).digest("hex"),
      detail: "test fixture",
      scannedAt: new Date().toISOString(),
    },
  });
  const findings = governance.listDlpFindings(admin.userId, matterOne.id);
  assert.ok(findings.some((finding) => finding.finding_type === "privileged"));
  assert.ok(
    findings.some((finding) => finding.finding_type === "personal_data"),
  );

  const exportCheckpoint = (await repository.requestApproval(
    admin,
    matterOne.id,
    {
      action: "audit_pack_export",
      requestedPayload: { matterId: matterOne.id },
    },
  )) as { id: string };
  await repository.decideApproval(admin, matterOne.id, exportCheckpoint.id, {
    decision: "approved",
  });
  await expectGovernanceCode("APPROVAL_REQUIRED", () =>
    repository.createLocalExportPackage(admin, matterOne.id, {
      approvalCheckpointId: exportCheckpoint.id,
    }),
  );

  governance.setApprovalPolicy(admin.userId, matterOne.id, {
    action: "restricted_export",
    requiredApprovals: 2,
    eligibleRoles: ["reviewer", "auditor"],
    requireDistinctRoles: true,
    prohibitRequester: true,
  });
  const approval = governance.requestApproval(
    admin.userId,
    matterOne.id,
    "restricted_export",
    { exportType: "audit_pack" },
  ) as { id: string };
  await expectGovernanceCode("FORBIDDEN", () =>
    governance.voteApproval(admin.userId, approval.id, "approved"),
  );
  const firstVote = governance.voteApproval(
    "reviewer-one",
    approval.id,
    "approved",
  ) as { status: string };
  assert.equal(firstVote.status, "pending");
  await expectGovernanceCode("FORBIDDEN", () =>
    governance.voteApproval("reviewer-one", approval.id, "approved"),
  );
  const secondVote = governance.voteApproval(
    "auditor-two",
    approval.id,
    "approved",
  ) as { status: string };
  assert.equal(secondVote.status, "approved");

  const exportResult = (await repository.createLocalExportPackage(
    admin,
    matterOne.id,
    {
      approvalCheckpointId: exportCheckpoint.id,
      governanceApprovalRequestId: approval.id,
      includeChunks: false,
    },
  )) as { export_hash: string };
  assert.match(exportResult.export_hash, /^sha256:/);

  const singleUserGovernance = new LocalGovernanceService({
    databasePath,
    multiPrincipalEnabled: false,
  });
  const disabledPolicy = singleUserGovernance.setApprovalPolicy(
    admin.userId,
    matterTwo.id,
    {
      action: "restricted_export",
      requiredApprovals: 2,
      eligibleRoles: ["reviewer", "auditor"],
      enabled: true,
    },
  );
  assert.equal(disabledPolicy?.enabled, false);
  assert.equal(
    disabledPolicy?.disabled_reason,
    "single_user_mode_has_no_distinct_authenticated_principals",
  );
  singleUserGovernance.close();

  governance.close();
  const restarted = new LocalGovernanceService({
    databasePath,
    multiPrincipalEnabled: true,
  });
  const persisted = restarted.governance(admin.userId, matterOne.id);
  assert.equal(persisted.classification, "restricted");
  assert.equal(
    restarted.listDlpFindings(admin.userId, matterOne.id).length,
    findings.length,
  );
  assert.equal(
    (restarted.approvalRequest(approval.id) as { status: string }).status,
    "approved",
  );
  restarted.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        databasePath,
        assertions: {
          crossMatterAcl: true,
          litigationReviewUsesOwnerActorSeparation: true,
          litigationReviewPermissionsEnforced: true,
          litigationSignoffRestrictedToCounselOrAdmin: true,
          litigationAnchorRestrictedToGlobalAdmin: true,
          aclMatterDiscoveryScoped: true,
          litigationSelfReviewRejected: true,
          legalHoldBlocksPurge: true,
          retentionBlocksPurge: true,
          evidenceLockBlocksDocumentWrite: true,
          distinctPrincipalAndRoleApproval: true,
          singleUserDualControlNotClaimed: true,
          dlpFindingsPersisted: findings.length,
          restrictedExportFailClosed: true,
          restartPersistence: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
