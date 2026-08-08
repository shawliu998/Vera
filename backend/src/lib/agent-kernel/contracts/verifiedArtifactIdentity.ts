import { z } from "zod";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const VERIFIED_DRAFT_ARTIFACT_IDENTITY_KIND =
  "agent_verified_draft_artifact_v1" as const;
export const VERIFIED_TABULAR_ARTIFACT_IDENTITY_KIND =
  "agent_verified_tabular_artifact_v1" as const;

/** Server-built verifier identity. It must never be populated by model output. */
export const verifiedDraftArtifactIdentitySchema = z
  .object({
    kind: z.literal(VERIFIED_DRAFT_ARTIFACT_IDENTITY_KIND),
    document_id: uuid,
    version_id: uuid,
    // This is the normalized accepted-view text hash, not the approved
    // DocumentVersion bytes hash used by final export.
    accepted_view_sha256: sha256,
  })
  .strict();

export const verifiedTabularArtifactIdentitySchema = z
  .object({
    kind: z.literal(VERIFIED_TABULAR_ARTIFACT_IDENTITY_KIND),
    review_id: uuid,
    row_protocol: z.literal("document_rows"),
    input_digest: digest,
    revision_fingerprint: digest,
    accepted_view_sha256: sha256,
    source_receipt_fingerprint: digest.nullable(),
    decision_fingerprint: digest.nullable(),
    completion_sha256: sha256.nullable(),
  })
  .strict();

export const verifiedArtifactIdentitySchema = z.discriminatedUnion("kind", [
  verifiedDraftArtifactIdentitySchema,
  verifiedTabularArtifactIdentitySchema,
]);

export type VerifiedArtifactIdentity = z.infer<
  typeof verifiedArtifactIdentitySchema
>;
export type VerifiedTabularArtifactIdentity = z.infer<
  typeof verifiedTabularArtifactIdentitySchema
>;
