import { z } from "zod";

export {
  VERIFIED_DRAFT_ARTIFACT_IDENTITY_KIND,
  VERIFIED_TABULAR_ARTIFACT_IDENTITY_KIND,
  verifiedArtifactIdentitySchema,
  verifiedDraftArtifactIdentitySchema,
  verifiedTabularArtifactIdentitySchema,
  type VerifiedArtifactIdentity,
  type VerifiedTabularArtifactIdentity,
} from "./agent-kernel/contracts/verifiedArtifactIdentity";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const filename = z.string().trim().min(1).max(500);
const purpose = z.string().trim().min(1).max(300);
const MAX_APPROVED_EXPORT_BYTES = 100 * 1024 * 1024;

export const APPROVED_TABULAR_ARTIFACT_SNAPSHOT_KIND =
  "agent_approved_tabular_artifact_v1" as const;

/** The historical DocumentVersion approval shape remains readable unchanged. */
export const legacyApprovedDraftArtifactSnapshotSchema = z
  .object({
    artifact_type: z.literal("draft"),
    artifact_id: uuid,
    // Historical data is intentionally parsed leniently below; this is only
    // the retained draft shape already committed by earlier releases.
    purpose: z.string(),
    document_id: uuid,
    version_id: uuid,
    version_number: z.number().int().nullable(),
    filename,
    file_type: z.string().nullable(),
    size_bytes: z.number().int().nonnegative(),
    sha256,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifact_id !== value.document_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_id"],
        message: "A draft approval must identify its same Document",
      });
    }
  });

/** Historical seven-field Tabular identity: read-only, never exportable. */
export const legacyApprovedTabularArtifactSnapshotSchema = z
  .object({
    artifact_type: z.literal("tabular_review"),
    artifact_id: uuid,
    purpose: z.string(),
    review_id: uuid,
    row_protocol: z.literal("document_rows"),
    input_digest: digest,
    revision_fingerprint: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifact_id !== value.review_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_id"],
        message: "A Tabular approval must identify its same Review",
      });
    }
  });

export const approvedTabularArtifactSnapshotSchema = z
  .object({
    kind: z.literal(APPROVED_TABULAR_ARTIFACT_SNAPSHOT_KIND),
    artifact_type: z.literal("tabular_review"),
    artifact_id: uuid,
    purpose,
    review_id: uuid,
    row_protocol: z.literal("document_rows"),
    input_digest: digest,
    revision_fingerprint: digest,
    accepted_view_sha256: sha256,
    source_receipt_fingerprint: digest.nullable(),
    decision_fingerprint: digest.nullable(),
    completion_sha256: sha256.nullable(),
    export_document_id: uuid,
    export_version_id: uuid,
    version_number: z.number().int().min(1),
    filename,
    file_type: z.literal("xlsx"),
    size_bytes: z.number().int().min(1).max(MAX_APPROVED_EXPORT_BYTES),
    sha256,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifact_id !== value.review_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_id"],
        message: "A Tabular approval must identify its same Review",
      });
    }
  });

export const approvedArtifactSnapshotSchema = z.union([
  legacyApprovedDraftArtifactSnapshotSchema,
  legacyApprovedTabularArtifactSnapshotSchema,
  approvedTabularArtifactSnapshotSchema,
]);
export type ApprovedArtifactSnapshot = z.infer<
  typeof approvedArtifactSnapshotSchema
>;
export type ApprovedTabularArtifactSnapshot = z.infer<
  typeof approvedTabularArtifactSnapshotSchema
>;

export type ReadApprovedArtifactSnapshot =
  | { state: "current"; artifact: z.infer<typeof legacyApprovedDraftArtifactSnapshotSchema> }
  | { state: "current"; artifact: ApprovedTabularArtifactSnapshot }
  | { state: "legacy_tabular"; artifact: z.infer<typeof legacyApprovedTabularArtifactSnapshotSchema> }
  | { state: "invalid" };

/**
 * Old seven-field Tabular rows can explain historic state but cannot authorize
 * a new approval or export because they have no accepted-view/export binding.
 */
export function readApprovedArtifactSnapshot(
  value: unknown,
): ReadApprovedArtifactSnapshot {
  const parsed = approvedArtifactSnapshotSchema.safeParse(value);
  if (!parsed.success) return { state: "invalid" };
  if (
    parsed.data.artifact_type === "tabular_review" &&
    !("kind" in parsed.data)
  ) {
    return { state: "legacy_tabular", artifact: parsed.data };
  }
  if (parsed.data.artifact_type === "draft") {
    return { state: "current", artifact: parsed.data };
  }
  return { state: "current", artifact: parsed.data };
}
