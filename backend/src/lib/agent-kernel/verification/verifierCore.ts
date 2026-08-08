import { z } from "zod";

export const AGENT_VERIFICATION_PACKET_VERSION = 1 as const;
export const AGENT_VERIFICATION_RECORD_KEY =
  "agent_verification_result" as const;

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
      code: z.literal("artifact_unavailable"),
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
      code: z.literal("artifact_incomplete_ending"),
      deliverable_key: z.string().trim().min(1).max(120),
      document_id: z.string().uuid(),
      version_id: z.string().uuid(),
      accepted_view_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      ending_excerpt: z.string().trim().min(40).max(500),
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
      code: z.literal("verification_scope_exceeded"),
      deliverable_key: z.string().trim().min(1).max(120),
      accepted_view_characters: z.number().int().min(1),
      projected_characters: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      code: z.literal("tabular_review_invalid"),
      deliverable_key: z.string().trim().min(1).max(120),
      review_id: z.string().uuid(),
      reason: z
        .enum(["row_protocol", "layout", "source_scope", "cell_coordinate"])
        .describe("The server-owned Tabular Review integrity classification."),
      total_cells: z.number().int().min(0).max(50_000),
    })
    .strict(),
  z
    .object({
      code: z.literal("tabular_review_revision_unstable"),
      deliverable_key: z.string().trim().min(1).max(120),
      review_id: z.string().uuid(),
      reason: z.enum([
        "input_digest_unavailable",
        "input_digest_changed",
        "before_unavailable",
        "after_unavailable",
        "changed",
      ]),
      total_cells: z.number().int().min(0).max(50_000),
    })
    .strict(),
  z
    .object({
      code: z.literal("tabular_review_incomplete"),
      deliverable_key: z.string().trim().min(1).max(120),
      review_id: z.string().uuid(),
      total_cells: z.number().int().min(0).max(50_000),
      incomplete_cells: z.number().int().min(1).max(50_000),
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

const TERMINAL_SENTENCE_ENDING = /[。！？.!?][”’"'）)\]】》〉」』〕]*$/u;
const CHINESE_CONTINUATION_ENDING =
  /(?:均明确标注为|明确标注为|列示为|说明为|载明为|表述为|认定为|界定为|定义为|称为|视为|包括|如下|下列|以及|并且|而且|或者|但是|即|例如)(?:[：:]?)$/u;
const ENGLISH_CONTINUATION_ENDING =
  /(?:^|\s)(?:including|as follows|such as|and|or|but|means|is|are|to|of|for|with|by)(?:[：:]?)$/iu;

/**
 * Detect only a high-confidence abrupt prose ending. This is deliberately
 * narrower than a general writing-quality heuristic: it requires a substantial
 * final paragraph, no terminal sentence punctuation, and an explicit lexical
 * continuation marker. The returned excerpt is evidence, not replacement text.
 */
export function detectArtifactIncompleteEnding(
  acceptedView: string,
): string | null {
  const finalParagraph = acceptedView
    .split(/\r?\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .at(-1);
  if (
    !finalParagraph ||
    finalParagraph.length < 40 ||
    TERMINAL_SENTENCE_ENDING.test(finalParagraph) ||
    (!CHINESE_CONTINUATION_ENDING.test(finalParagraph) &&
      !ENGLISH_CONTINUATION_ENDING.test(finalParagraph))
  ) {
    return null;
  }
  return finalParagraph.slice(-500);
}

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
    accepted_view_text: z.string().max(100_000).nullable(),
    accepted_view_complete: z.boolean(),
  })
  .strict()
  .superRefine((deliverable, context) => {
    const identityFields = [
      deliverable.document_id,
      deliverable.current_version_id,
    ];
    const hasIdentity = identityFields.some((value) => value !== null);
    const hasCompleteIdentity = identityFields.every((value) => value !== null);
    const hasAcceptedHash = deliverable.accepted_view_sha256 !== null;
    const hasAcceptedText = deliverable.accepted_view_text !== null;
    const acceptedViewRequiresDocument = deliverable.artifact_type === "draft";
    const invalidDraftIdentity =
      acceptedViewRequiresDocument && hasIdentity && !hasCompleteIdentity;
    const invalidTabularIdentity = !acceptedViewRequiresDocument && hasIdentity;
    const invalidAcceptedViewIdentity = acceptedViewRequiresDocument
      ? (hasAcceptedHash || hasAcceptedText) && !hasCompleteIdentity
      : deliverable.artifact_id === null &&
        (hasAcceptedHash || hasAcceptedText);
    if (
      (deliverable.artifact_id === null &&
        (hasIdentity || hasAcceptedHash || hasAcceptedText)) ||
      invalidDraftIdentity ||
      invalidTabularIdentity ||
      invalidAcceptedViewIdentity ||
      (deliverable.accepted_view_complete &&
        (!hasAcceptedHash || !hasAcceptedText)) ||
      (!deliverable.accepted_view_complete &&
        hasAcceptedText &&
        !hasAcceptedHash)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["document_id"],
        message:
          "A draft needs a complete current document identity; a Tabular Review uses its Artifact identity and must not impersonate a Document",
      });
    }
  });

const sourceSchema = z
  .object({
    document_id: z.string().uuid(),
    version_id: z.string().uuid(),
    role: z.enum(["source", "template", "precedent", "authority"]),
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

/**
 * Semantic verification is sound only for complete accepted views. Missing,
 * unreadable, drifted, or deliberately bounded projections remain visible in
 * the full server-owned packet and are routed by deterministic checks. They
 * must not become material-goal findings merely because a model saw a partial
 * view or a workflow status such as a lawyer-preserved unresolved cell.
 */
export function buildAgentSemanticVerifierProjectionV1(
  packet: AgentVerificationPacketV1,
): AgentVerificationPacketV1 {
  const fixed = buildAgentVerificationPacketV1(packet);
  return buildAgentVerificationPacketV1({
    ...fixed,
    deliverables: fixed.deliverables.filter(
      (deliverable) => deliverable.accepted_view_complete,
    ),
    // Source and deterministic facts remain server-owned. The semantic model
    // receives only the bounded work product needed to compare against goal.
    source_versions: [],
    deterministic_checks: [],
  });
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

const verificationMergedIssueSchema = z.discriminatedUnion("origin", [
  z
    .object({
      origin: z.literal("deterministic"),
      dimension: dimensionSchema,
      detail: z.string().trim().min(1).max(2_000),
      issue: deterministicIssueSchema,
    })
    .strict(),
  z
    .object({
      origin: z.literal("semantic"),
      dimension: z.literal("goal_coverage"),
      detail: z.string().trim().min(1).max(2_000),
      issue: semanticIssueSchema,
    })
    .strict(),
]);

const verificationResultSchema = z
  .object({
    kind: z.literal("agent_verification_result_v1"),
    outcome: z.enum(["clean_pass", "review_required"]),
    dimensions: z
      .object({
        goal_coverage: z.enum(["pass", "gap"]),
        source_support: z.enum(["pass", "gap"]),
        artifact_integrity: z.enum(["pass", "gap"]),
        workflow_completion: z.enum(["pass", "gap"]),
      })
      .strict(),
    issues: z.array(verificationMergedIssueSchema).max(120),
  })
  .strict()
  .superRefine((result, context) => {
    const expectedOutcome = result.issues.length
      ? "review_required"
      : "clean_pass";
    if (result.outcome !== expectedOutcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Verifier outcome must match the structured issue set",
      });
    }
    for (const dimension of dimensionSchema.options) {
      const expected = result.issues.some(
        (issue) => issue.dimension === dimension,
      )
        ? "gap"
        : "pass";
      if (result.dimensions[dimension] !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dimensions", dimension],
          message: "Verifier dimensions must be derived from structured issues",
        });
      }
    }
  });

const verificationRecordSchema = z
  .object({
    kind: z.literal("agent_verification_record_v1"),
    task_id: z.string().uuid(),
    step_id: z.string().trim().min(1).max(200),
    step_attempt: z.number().int().min(1),
    result: verificationResultSchema,
  })
  .strict();

export type AgentVerificationRecordV1 = z.infer<
  typeof verificationRecordSchema
>;

export function buildAgentVerificationRecordV1(input: {
  packet: AgentVerificationPacketV1;
  result: AgentVerificationResultV1;
}): AgentVerificationRecordV1 {
  const packet = buildAgentVerificationPacketV1(input.packet);
  return verificationRecordSchema.parse({
    kind: "agent_verification_record_v1",
    task_id: packet.task_id,
    step_id: packet.step_id,
    step_attempt: packet.step_attempt,
    result: input.result,
  });
}

export function readAgentVerificationRecordV1(checkpoint: unknown):
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; record: AgentVerificationRecordV1 } {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { state: "absent" };
  }
  const row = checkpoint as Record<string, unknown>;
  if (!Object.hasOwn(row, AGENT_VERIFICATION_RECORD_KEY)) {
    return { state: "absent" };
  }
  const parsed = verificationRecordSchema.safeParse(
    row[AGENT_VERIFICATION_RECORD_KEY],
  );
  return parsed.success
    ? { state: "valid", record: parsed.data }
    : { state: "invalid" };
}

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
  const semanticDeliverableKeys = new Set(
    packet.deliverables
      .filter((deliverable) => deliverable.accepted_view_complete)
      .map((deliverable) => deliverable.key),
  );
  for (const issue of semantic.issues) {
    if (
      !semanticDeliverableKeys.has(issue.deliverable_key) ||
      !packet.goal.includes(issue.goal_excerpt)
    ) {
      throw new AgentVerifierStructuredOutputError(
        "Semantic issue is not bound to the fixed goal and one complete accepted-view deliverable",
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
