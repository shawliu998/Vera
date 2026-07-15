import { createHash } from "node:crypto";

import type {
  ProjectSourceKindV11,
  SourceDataUsePolicyV11,
  SourceRetentionPolicyV11,
} from "./sourceFoundationContractsV11";

export const SOURCE_RETENTION_ACTIONS_V13 = [
  "metadata_read",
  "quote_read",
  "anchor_create",
  "studio_bind",
  "derived_payload_read",
  "model_use",
  "export_exact_quote",
  "export_work_product",
] as const;

export type SourceRetentionActionV13 =
  (typeof SOURCE_RETENTION_ACTIONS_V13)[number];

export const SOURCE_RETENTION_DENIAL_CODES_V13 = [
  "source_retention_lifecycle_missing",
  "source_retention_lifecycle_invalid",
  "source_retention_tombstoned",
  "source_retention_expired",
  "source_retention_policy_prohibited",
  "source_retention_local_model_required",
  "source_retention_review_required",
] as const;

export type SourceRetentionDenialCodeV13 =
  (typeof SOURCE_RETENTION_DENIAL_CODES_V13)[number];

export type SourceRetentionLifecycleStateV13 = "available" | "tombstoned";
export type SourceRetentionCleanupStateV13 =
  | "not_required"
  | "pending"
  | "blocked_legacy_anchor"
  | "complete"
  | "failed";

export type SourceRetentionReasonV13 =
  | "retention_disallowed"
  | "ttl_expired"
  | "invalid_policy"
  | "policy_revoked"
  | "manual_tombstone";

export type SourceRetentionLifecycleV13 = {
  projectId: string;
  snapshotId: string;
  accessState: SourceRetentionLifecycleStateV13;
  expiresAtEpochMs: number | null;
  tombstoneReason: SourceRetentionReasonV13 | null;
  tombstonedAtEpochMs: number | null;
  cleanupState: SourceRetentionCleanupStateV13;
  updatedAtEpochMs: number;
};

export type SourceRetentionPolicySubjectV13 = {
  id: string;
  projectId: string;
  sourceKind: ProjectSourceKindV11;
  license: SourceDataUsePolicyV11;
  retentionPolicy: SourceRetentionPolicyV11;
  retentionExpiresAt: string | null;
};

export type SourceRetentionPolicyContextV13 = {
  nowEpochMs: number;
  lifecycle: SourceRetentionLifecycleV13 | null;
  modelExecution?: "local" | "remote" | "unknown";
  reviewedWorkProduct?: boolean;
};

export type SourceRetentionPolicyDecisionV13 = {
  allowed: boolean;
  action: SourceRetentionActionV13;
  denialCode: SourceRetentionDenialCodeV13 | null;
  policyFingerprint: string;
  effectiveExpiresAtEpochMs: number | null;
};

/**
 * This is deliberately a code-owned closed gate. The v13 slice can deny reads,
 * anchor creation, Studio binding, model use, and export, but v11 legal anchors
 * still persist `exact_quote` as immutable plaintext inside SQLCipher. There is
 * no honest physical-cleanup claim until that payload is moved behind a
 * deletable encrypted blob/offset representation and derived-artifact lineage
 * is enforced at every model and export call site.
 */
export const LEGAL_SOURCE_RETENTION_ACTIVATION_V13 = Object.freeze({
  open: false as const,
  code: "activation_gate_closed" as const,
  blockers: Object.freeze([
    "legal_exact_quote_physical_cleanup_unimplemented",
    "legal_full_text_blob_lifecycle_unimplemented",
    "derived_artifact_lineage_incomplete",
    "model_and_export_call_sites_not_fully_wired",
  ]),
});

function finiteEpoch(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parsedExpiry(subject: SourceRetentionPolicySubjectV13) {
  if (subject.retentionPolicy !== "full_text_ttl") return null;
  if (subject.retentionExpiresAt === null) return Number.NaN;
  return Date.parse(subject.retentionExpiresAt);
}

export function sourceRetentionPolicyFingerprintV13(
  subject: SourceRetentionPolicySubjectV13,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceKind: subject.sourceKind,
        basis: subject.license.basis,
        retention: subject.license.retention,
        export: subject.license.export,
        modelUse: subject.license.modelUse,
        retentionPolicy: subject.retentionPolicy,
        retentionExpiresAt: subject.retentionExpiresAt,
      }),
      "utf8",
    )
    .digest("hex");
}

function denied(
  subject: SourceRetentionPolicySubjectV13,
  action: SourceRetentionActionV13,
  denialCode: SourceRetentionDenialCodeV13,
  expiry: number | null,
): SourceRetentionPolicyDecisionV13 {
  return {
    allowed: false,
    action,
    denialCode,
    policyFingerprint: sourceRetentionPolicyFingerprintV13(subject),
    effectiveExpiresAtEpochMs: expiry,
  };
}

function allowed(
  subject: SourceRetentionPolicySubjectV13,
  action: SourceRetentionActionV13,
  expiry: number | null,
): SourceRetentionPolicyDecisionV13 {
  return {
    allowed: true,
    action,
    denialCode: null,
    policyFingerprint: sourceRetentionPolicyFingerprintV13(subject),
    effectiveExpiresAtEpochMs: expiry,
  };
}

/**
 * Pure, provider-neutral policy evaluation. Metadata remains readable after a
 * logical tombstone so UI/audit surfaces can explain why payload access is no
 * longer available. Every payload-bearing action fails closed.
 */
export function evaluateSourceRetentionPolicyV13(
  subject: SourceRetentionPolicySubjectV13,
  action: SourceRetentionActionV13,
  context: SourceRetentionPolicyContextV13,
): SourceRetentionPolicyDecisionV13 {
  const expiry = parsedExpiry(subject);

  if (action === "metadata_read") {
    return allowed(subject, action, Number.isFinite(expiry) ? expiry : null);
  }

  if (!finiteEpoch(context.nowEpochMs)) {
    return denied(subject, action, "source_retention_lifecycle_invalid", null);
  }
  const lifecycle = context.lifecycle;
  if (!lifecycle) {
    return denied(subject, action, "source_retention_lifecycle_missing", null);
  }
  if (
    lifecycle.projectId !== subject.projectId ||
    lifecycle.snapshotId !== subject.id ||
    !finiteEpoch(lifecycle.updatedAtEpochMs)
  ) {
    return denied(subject, action, "source_retention_lifecycle_invalid", null);
  }
  if (lifecycle.accessState === "tombstoned") {
    return denied(
      subject,
      action,
      "source_retention_tombstoned",
      lifecycle.expiresAtEpochMs,
    );
  }

  if (
    subject.license.retention !== subject.retentionPolicy ||
    subject.license.basis === "not_declared" ||
    (subject.sourceKind === "project_document" &&
      (subject.license.basis !== "user_provided" ||
        subject.retentionPolicy !== "full_text_permitted")) ||
    (subject.retentionPolicy !== "full_text_permitted" &&
      subject.retentionPolicy !== "full_text_ttl")
  ) {
    return denied(
      subject,
      action,
      "source_retention_policy_prohibited",
      lifecycle.expiresAtEpochMs,
    );
  }

  if (subject.retentionPolicy === "full_text_ttl") {
    if (
      typeof expiry !== "number" ||
      !Number.isSafeInteger(expiry) ||
      expiry < 0 ||
      lifecycle.expiresAtEpochMs === null ||
      Math.abs(lifecycle.expiresAtEpochMs - expiry) > 1
    ) {
      return denied(
        subject,
        action,
        "source_retention_lifecycle_invalid",
        lifecycle.expiresAtEpochMs,
      );
    }
    if (expiry <= context.nowEpochMs) {
      return denied(subject, action, "source_retention_expired", expiry);
    }
  } else if (lifecycle.expiresAtEpochMs !== null) {
    return denied(
      subject,
      action,
      "source_retention_lifecycle_invalid",
      lifecycle.expiresAtEpochMs,
    );
  }

  if (action === "model_use") {
    if (
      subject.license.modelUse === "not_declared" ||
      subject.license.modelUse === "prohibited"
    ) {
      return denied(
        subject,
        action,
        "source_retention_policy_prohibited",
        lifecycle.expiresAtEpochMs,
      );
    }
    if (
      subject.license.modelUse === "local_only" &&
      context.modelExecution !== "local"
    ) {
      return denied(
        subject,
        action,
        "source_retention_local_model_required",
        lifecycle.expiresAtEpochMs,
      );
    }
  }

  if (action === "export_exact_quote") {
    if (
      subject.license.export !== "exact_quotes_only" &&
      subject.license.export !== "permitted"
    ) {
      return denied(
        subject,
        action,
        "source_retention_policy_prohibited",
        lifecycle.expiresAtEpochMs,
      );
    }
  }

  if (action === "export_work_product") {
    if (
      subject.license.export === "reviewed_work_product" &&
      context.reviewedWorkProduct !== true
    ) {
      return denied(
        subject,
        action,
        "source_retention_review_required",
        lifecycle.expiresAtEpochMs,
      );
    }
    if (
      subject.license.export !== "permitted" &&
      subject.license.export !== "reviewed_work_product"
    ) {
      return denied(
        subject,
        action,
        "source_retention_policy_prohibited",
        lifecycle.expiresAtEpochMs,
      );
    }
  }

  return allowed(subject, action, lifecycle.expiresAtEpochMs);
}
