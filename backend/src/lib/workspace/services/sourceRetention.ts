import { createHash } from "node:crypto";

import {
  WorkspaceSourceRetentionLifecycleRepository,
  type SourceRetentionAnchorUseRecordV13,
  type SourceRetentionReadinessV13,
  type SourceRetentionUseRecordV13,
} from "../repositories/sourceRetentionLifecycle";
import {
  LEGAL_SOURCE_RETENTION_ACTIVATION_V13,
  evaluateSourceRetentionPolicyV13,
  type SourceRetentionActionV13,
  type SourceRetentionDenialCodeV13,
  type SourceRetentionPolicyContextV13,
  type SourceRetentionPolicyDecisionV13,
} from "../sourceRetentionPolicyV13";

export type WorkspaceSourceRetentionServiceErrorCode =
  | "SOURCE_RETENTION_NOT_FOUND"
  | "SOURCE_RETENTION_PROVENANCE_INVALID"
  | SourceRetentionDenialCodeV13;

export class WorkspaceSourceRetentionServiceError extends Error {
  constructor(
    readonly code: WorkspaceSourceRetentionServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceSourceRetentionServiceError";
  }
}

export type SourceRetentionAnchorMetadataV13 = {
  id: string;
  projectId: string;
  snapshotId: string;
  ordinal: number;
  quoteSha256: string;
  locator: Record<string, unknown>;
  createdAt: string;
  quoteAvailable: boolean;
  accessState: "available" | "tombstoned" | "lifecycle_missing";
  tombstoneReason: string | null;
  denialCode: SourceRetentionDenialCodeV13 | null;
};

function serviceError(
  code: WorkspaceSourceRetentionServiceErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WorkspaceSourceRetentionServiceError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function denialMessage(code: SourceRetentionDenialCodeV13) {
  switch (code) {
    case "source_retention_lifecycle_missing":
    case "source_retention_lifecycle_invalid":
      return "Source payload access is unavailable because its retention lifecycle is invalid.";
    case "source_retention_tombstoned":
      return "Source payload access is unavailable because the source is tombstoned.";
    case "source_retention_expired":
      return "Source payload access is unavailable because its retention period expired.";
    case "source_retention_local_model_required":
      return "This source may only be used with a verified local model.";
    case "source_retention_review_required":
      return "This source requires a hash-bound reviewed work product before export.";
    case "source_retention_policy_prohibited":
      return "The source data-use policy prohibits this operation.";
  }
}

function assertAllowed(decision: SourceRetentionPolicyDecisionV13) {
  if (decision.allowed) return decision;
  const denialCode = decision.denialCode;
  if (!denialCode) {
    serviceError(
      "source_retention_lifecycle_invalid",
      "Source payload access failed closed.",
    );
  }
  serviceError(denialCode, denialMessage(denialCode));
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Provider-neutral retention coordinator. It performs a bounded due sweep
 * before every policy decision so a logical tombstone is durable immediately;
 * the pure evaluator still checks expiry independently, which keeps access
 * fail-closed if a sweep fails or has not run yet.
 */
export class WorkspaceSourceRetentionService {
  constructor(
    private readonly repository: WorkspaceSourceRetentionLifecycleRepository,
    private readonly nowEpochMs: () => number = () => Date.now(),
  ) {}

  startupSweep() {
    return this.repository.tombstoneDueLegalSources(this.nowEpochMs());
  }

  readiness(): SourceRetentionReadinessV13 {
    return this.repository.readiness(this.nowEpochMs());
  }

  providerActivation() {
    return LEGAL_SOURCE_RETENTION_ACTIVATION_V13;
  }

  evaluateSnapshotAction(input: {
    projectId: string;
    snapshotId: string;
    action: SourceRetentionActionV13;
    modelExecution?: "local" | "remote" | "unknown";
    reviewedWorkProduct?: boolean;
  }) {
    const sweep = this.repository.tombstoneDueLegalSources(this.nowEpochMs());
    const record = this.repository.getSourceUseRecord(
      input.projectId,
      input.snapshotId,
    );
    if (!record) {
      serviceError(
        "SOURCE_RETENTION_NOT_FOUND",
        "Source snapshot was not found.",
      );
    }
    return {
      record,
      decision: evaluateSourceRetentionPolicyV13(
        record.subject,
        input.action,
        this.policyContext(record, sweep.effectiveNowEpochMs, input),
      ),
    };
  }

  assertSnapshotAction(input: {
    projectId: string;
    snapshotId: string;
    action: SourceRetentionActionV13;
    modelExecution?: "local" | "remote" | "unknown";
    reviewedWorkProduct?: boolean;
  }) {
    const evaluated = this.evaluateSnapshotAction(input);
    assertAllowed(evaluated.decision);
    return evaluated;
  }

  readAnchorMetadata(
    projectId: string,
    anchorId: string,
  ): SourceRetentionAnchorMetadataV13 {
    const sweep = this.repository.tombstoneDueLegalSources(this.nowEpochMs());
    const record = this.repository.getAnchorUseRecord(projectId, anchorId);
    if (!record) {
      serviceError(
        "SOURCE_RETENTION_NOT_FOUND",
        "Source citation anchor was not found.",
      );
    }
    const quoteDecision = evaluateSourceRetentionPolicyV13(
      record.subject,
      "quote_read",
      this.policyContext(record, sweep.effectiveNowEpochMs, {}),
    );
    return {
      id: record.anchor.id,
      projectId: record.anchor.projectId,
      snapshotId: record.anchor.snapshotId,
      ordinal: record.anchor.ordinal,
      quoteSha256: record.anchor.quoteSha256,
      locator: record.anchor.locator,
      createdAt: record.anchor.createdAt,
      quoteAvailable: quoteDecision.allowed,
      accessState: record.lifecycle
        ? record.lifecycle.accessState
        : "lifecycle_missing",
      tombstoneReason: record.lifecycle?.tombstoneReason ?? null,
      denialCode: quoteDecision.denialCode,
    };
  }

  readAnchorQuote(projectId: string, anchorId: string) {
    const sweep = this.repository.tombstoneDueLegalSources(this.nowEpochMs());
    const record = this.repository.getAnchorUseRecord(projectId, anchorId);
    if (!record) {
      serviceError(
        "SOURCE_RETENTION_NOT_FOUND",
        "Source citation anchor was not found.",
      );
    }
    const decision = evaluateSourceRetentionPolicyV13(
      record.subject,
      "quote_read",
      this.policyContext(record, sweep.effectiveNowEpochMs, {}),
    );
    assertAllowed(decision);
    if (sha256(record.anchor.exactQuote) !== record.anchor.quoteSha256) {
      serviceError(
        "SOURCE_RETENTION_PROVENANCE_INVALID",
        "Source citation provenance failed integrity verification.",
      );
    }
    return {
      ...this.anchorMetadata(record, decision),
      exactQuote: record.anchor.exactQuote,
    };
  }

  assertStudioAnchorBindings(input: {
    projectId: string;
    anchorIds: readonly string[];
  }) {
    const sweep = this.repository.tombstoneDueLegalSources(this.nowEpochMs());
    const decisions: SourceRetentionPolicyDecisionV13[] = [];
    for (const anchorId of new Set(input.anchorIds)) {
      const record = this.repository.getAnchorUseRecord(
        input.projectId,
        anchorId,
      );
      if (!record) {
        serviceError(
          "SOURCE_RETENTION_NOT_FOUND",
          "Source citation anchor was not found.",
        );
      }
      const decision = evaluateSourceRetentionPolicyV13(
        record.subject,
        "studio_bind",
        this.policyContext(record, sweep.effectiveNowEpochMs, {}),
      );
      assertAllowed(decision);
      decisions.push(decision);
    }
    return decisions;
  }

  assertStudioVersionAction(input: {
    projectId: string;
    documentId: string;
    versionId: string;
    action:
      | "derived_payload_read"
      | "model_use"
      | "export_exact_quote"
      | "export_work_product";
    modelExecution?: "local" | "remote" | "unknown";
    reviewedWorkProduct?: boolean;
  }) {
    const sweep = this.repository.tombstoneDueLegalSources(this.nowEpochMs());
    const records = this.repository.listStudioVersionSourceUseRecords(input);
    const decisions = records.map((record) =>
      evaluateSourceRetentionPolicyV13(
        record.subject,
        input.action,
        this.policyContext(record, sweep.effectiveNowEpochMs, input),
      ),
    );
    decisions.forEach(assertAllowed);
    return decisions;
  }

  tombstoneLegalSnapshot(input: {
    projectId: string;
    snapshotId: string;
    reason: "policy_revoked" | "manual_tombstone";
  }) {
    return this.repository.tombstoneLegalSnapshot({
      ...input,
      nowEpochMs: this.nowEpochMs(),
    });
  }

  private policyContext(
    record: SourceRetentionUseRecordV13,
    effectiveNowEpochMs: number,
    input: {
      modelExecution?: "local" | "remote" | "unknown";
      reviewedWorkProduct?: boolean;
    },
  ): SourceRetentionPolicyContextV13 {
    return {
      nowEpochMs: effectiveNowEpochMs,
      lifecycle: record.lifecycle,
      modelExecution: input.modelExecution ?? "unknown",
      reviewedWorkProduct: input.reviewedWorkProduct ?? false,
    };
  }

  private anchorMetadata(
    record: SourceRetentionAnchorUseRecordV13,
    decision: SourceRetentionPolicyDecisionV13,
  ): SourceRetentionAnchorMetadataV13 {
    return {
      id: record.anchor.id,
      projectId: record.anchor.projectId,
      snapshotId: record.anchor.snapshotId,
      ordinal: record.anchor.ordinal,
      quoteSha256: record.anchor.quoteSha256,
      locator: record.anchor.locator,
      createdAt: record.anchor.createdAt,
      quoteAvailable: decision.allowed,
      accessState: record.lifecycle
        ? record.lifecycle.accessState
        : "lifecycle_missing",
      tombstoneReason: record.lifecycle?.tombstoneReason ?? null,
      denialCode: decision.denialCode,
    };
  }
}
