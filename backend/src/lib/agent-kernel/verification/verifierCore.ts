import { z } from "zod";

export const AGENT_VERIFICATION_PACKET_VERSION = 1 as const;

const artifactTypeSchema = z.enum(["draft", "tabular_review"]);
const dimensionSchema = z.enum([
  "goal_coverage",
  "source_support",
  "artifact_integrity",
  "workflow_completion",
]);

const exactCitationSchema = z
  .object({
    marker: z.number().int().min(1).max(500),
    source_document_id: z.string().uuid(),
    source_version_id: z.string().uuid(),
    quote: z.string().trim().min(1).max(4_000),
  })
  .strict();

const deterministicIssueSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("artifact_missing"),
      deliverable_key: z.string().trim().min(1).max(120),
      artifact_type: artifactTypeSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal("artifact_outside_matter"),
      deliverable_key: z.string().trim().min(1).max(120),
      artifact_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      code: z.literal("artifact_version_changed"),
      deliverable_key: z.string().trim().min(1).max(120),
      document_id: z.string().uuid(),
      expected_version_id: z.string().uuid(),
      current_version_id: z.string().uuid().nullable(),
    })
    .strict(),
  z
    .object({
      code: z.literal("accepted_view_unreadable"),
      deliverable_key: z.string().trim().min(1).max(120),
      document_id: z.string().uuid(),
      version_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      code: z.literal("citation_snapshot_missing"),
      deliverable_key: z.string().trim().min(1).max(120).nullable(),
    })
    .strict(),
  z
    .object({
      code: z.literal("citation_relocation_gap"),
      deliverable_key: z.string().trim().min(1).max(120).nullable(),
      total: z.number().int().min(1).max(5_000),
      missing: z.number().int().min(1).max(5_000),
      statuses: z
        .array(z.enum(["drifted", "missing", "version_mismatch"]))
        .min(1)
        .max(5_000),
    })
    .strict(),
  z
    .object({
      code: z.literal("citation_marker_gap"),
      deliverable_key: z.string().trim().min(1).max(120),
      document_id: z.string().uuid(),
      version_id: z.string().uuid(),
      accepted_view_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      citations: z.array(exactCitationSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      code: z.literal("prior_step_incomplete"),
      step_positions: z.array(z.number().int().min(0).max(200)).min(1).max(200),
    })
    .strict(),
  z
    .object({
      code: z.literal("pack_check_gap"),
      profile_id: z.string().trim().min(1).max(160),
      check_code: z.string().trim().min(1).max(160),
      facts: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export type AgentVerifierDeterministicIssueV1 = z.infer<
  typeof deterministicIssueSchema
>;

const deterministicCheckSchema = z
  .object({
    code: z.string().trim().min(1).max(160),
    dimension: dimensionSchema,
    status: z.enum(["pass", "gap"]),
    detail: z.string().trim().min(1).max(2_000),
    issue: deterministicIssueSchema.nullable(),
  })
  .strict()
  .superRefine((check, context) => {
    if (
      (check.status === "pass" && check.issue !== null) ||
      (check.status === "gap" && check.issue === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue"],
        message: "A deterministic gap requires exactly one structured issue",
      });
    }
  });

const verifierProfileSchema = z
  .object({
    kind: z.literal("agent_verifier_profile_v1"),
    id: z.string().trim().min(1).max(160),
    version: z.string().trim().min(1).max(80),
    semantic_goal_check: z.boolean(),
    repair_policy: z.enum(["none", "one_bound_artifact"]),
  })
  .strict();

export type AgentVerifierProfileV1 = z.infer<typeof verifierProfileSchema>;

const deliverableSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    artifact_type: artifactTypeSchema,
    artifact_id: z.string().uuid().nullable(),
    document_id: z.string().uuid().nullable(),
    current_version_id: z.string().uuid().nullable(),
    accepted_view_sha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    accepted_view_text: z.string().max(200_000).nullable(),
  })
  .strict()
  .superRefine((deliverable, context) => {
    const documentFields = [
      deliverable.document_id,
      deliverable.current_version_id,
      deliverable.accepted_view_sha256,
      deliverable.accepted_view_text,
    ];
    const hasAny = documentFields.some((value) => value !== null);
    const hasEvery = documentFields.every((value) => value !== null);
    if ((deliverable.artifact_id === null && hasAny) || (hasAny && !hasEvery)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["document_id"],
        message: "Current document identity and accepted view must be complete",
      });
    }
  });

const sourceSchema = z
  .object({
    document_id: z.string().uuid(),
    version_id: z.string().uuid(),
    role: z.enum(["source", "template", "authority"]),
  })
  .strict();

const verificationPacketSchema = z
  .object({
    kind: z.literal("agent_verification_packet_v1"),
    version: z.literal(AGENT_VERIFICATION_PACKET_VERSION),
    task_id: z.string().uuid(),
    step_id: z.string().trim().min(1).max(200),
    step_attempt: z.number().int().min(1),
    matter_id: z.string().uuid(),
    goal: z.string().trim().min(1).max(20_000),
    profile: verifierProfileSchema,
    deliverables: z.array(deliverableSchema).max(30),
    source_versions: z.array(sourceSchema).max(500),
    deterministic_checks: z.array(deterministicCheckSchema).max(100),
  })
  .strict()
  .superRefine((packet, context) => {
    const keys = packet.deliverables.map((deliverable) => deliverable.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliverables"],
        message: "Verifier deliverable keys must be unique",
      });
    }
  });

export type AgentVerificationPacketV1 = z.infer<
  typeof verificationPacketSchema
>;

const semanticIssueSchema = z
  .object({
    code: z.literal("semantic_goal_omission"),
    deliverable_key: z.string().trim().min(1).max(120),
    goal_excerpt: z.string().trim().min(1).max(2_000),
    detail: z.string().trim().min(1).max(2_000),
  })
  .strict();

const semanticResultSchema = z
  .object({
    kind: z.literal("agent_semantic_verifier_result_v1"),
    goal_coverage: z.enum(["pass", "gap"]),
    issues: z.array(semanticIssueSchema).max(20),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.goal_coverage === "pass" && result.issues.length > 0) ||
      (result.goal_coverage === "gap" && result.issues.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issues"],
        message: "Semantic goal status must match its issues",
      });
    }
  });

export type AgentSemanticVerifierResultV1 = z.infer<
  typeof semanticResultSchema
>;

export class AgentVerifierStructuredOutputError extends Error {
  constructor(message = "Verifier returned an invalid structured result") {
    super(message);
    this.name = "AgentVerifierStructuredOutputError";
  }
}

function unwrapSingleJsonFence(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseAgentSemanticVerifierResult(raw: string) {
  try {
    return semanticResultSchema.parse(JSON.parse(unwrapSingleJsonFence(raw)));
  } catch {
    throw new AgentVerifierStructuredOutputError();
  }
}

export function buildAgentVerificationPacketV1(
  packet: AgentVerificationPacketV1,
) {
  return verificationPacketSchema.parse(packet);
}

export type AgentVerificationMergedIssueV1 =
  | {
      origin: "deterministic";
      dimension: z.infer<typeof dimensionSchema>;
      detail: string;
      issue: AgentVerifierDeterministicIssueV1;
    }
  | {
      origin: "semantic";
      dimension: "goal_coverage";
      detail: string;
      issue: z.infer<typeof semanticIssueSchema>;
    };

export type AgentVerificationResultV1 = {
  kind: "agent_verification_result_v1";
  outcome: "clean_pass" | "review_required";
  dimensions: Record<z.infer<typeof dimensionSchema>, "pass" | "gap">;
  issues: AgentVerificationMergedIssueV1[];
};

export function mergeAgentVerificationResultV1(input: {
  packet: AgentVerificationPacketV1;
  semanticResult: AgentSemanticVerifierResultV1;
}): AgentVerificationResultV1 {
  const packet = buildAgentVerificationPacketV1(input.packet);
  const semantic = semanticResultSchema.parse(input.semanticResult);
  if (!packet.profile.semantic_goal_check && semantic.issues.length) {
    throw new AgentVerifierStructuredOutputError(
      "Verifier profile does not authorize semantic issues",
    );
  }
  const deliverableKeys = new Set(
    packet.deliverables.map((deliverable) => deliverable.key),
  );
  for (const issue of semantic.issues) {
    if (
      !deliverableKeys.has(issue.deliverable_key) ||
      !packet.goal.includes(issue.goal_excerpt)
    ) {
      throw new AgentVerifierStructuredOutputError(
        "Semantic issue is not bound to the fixed goal and deliverable",
      );
    }
  }
  const deterministicIssues: AgentVerificationMergedIssueV1[] =
    packet.deterministic_checks.flatMap((check) =>
      check.status === "gap" && check.issue
        ? [
            {
              origin: "deterministic" as const,
              dimension: check.dimension,
              detail: check.detail,
              issue: check.issue,
            },
          ]
        : [],
    );
  const semanticIssues: AgentVerificationMergedIssueV1[] = semantic.issues.map(
    (issue) => ({
      origin: "semantic",
      dimension: "goal_coverage",
      detail: issue.detail,
      issue,
    }),
  );
  const issues = [...deterministicIssues, ...semanticIssues];
  const dimensions = {
    goal_coverage: "pass",
    source_support: "pass",
    artifact_integrity: "pass",
    workflow_completion: "pass",
  } as AgentVerificationResultV1["dimensions"];
  for (const issue of issues) dimensions[issue.dimension] = "gap";
  return {
    kind: "agent_verification_result_v1",
    outcome: issues.length ? "review_required" : "clean_pass",
    dimensions,
    issues,
  };
}

export function cleanSemanticVerifierResult(): AgentSemanticVerifierResultV1 {
  return {
    kind: "agent_semantic_verifier_result_v1",
    goal_coverage: "pass",
    issues: [],
  };
}
