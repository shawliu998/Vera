import { z } from "zod";

export const AGENT_EXECUTION_ISSUE_KIND = "agent_execution_issue_v1" as const;
export const AGENT_TASK_EXECUTION_PAUSE_KIND =
  "agent_task_execution_pause_v1" as const;

const retryClassificationSchema = z.enum([
  "rate_limit",
  "provider_unavailable",
  "timeout",
  "network",
]);
const pauseClassificationSchema = z.enum([
  "provider_capacity",
  "provider_timeout",
  "provider_network",
  "provider_protocol",
  "provider_structured_output",
  "provider_configuration",
]);
const providerIssueCodeSchema = z.enum([
  "provider_capacity_exhausted",
  "provider_timeout_exhausted",
  "provider_network_exhausted",
  "provider_protocol_incompatible",
  "provider_structured_output_invalid",
  "provider_configuration_required",
]);

export type AgentTaskRetryClassification = z.infer<
  typeof retryClassificationSchema
>;
export type AgentTaskExecutionPauseClassification = z.infer<
  typeof pauseClassificationSchema
>;
export type AgentTaskRetryCheckpoint = {
  attempt: number;
  retry_at: string;
  classification: AgentTaskRetryClassification;
};

const issueFactsSchema = z
  .object({
    step_id: z.string().trim().min(1).max(200),
    attempt: z.number().int().min(0),
    automatic_retries_exhausted: z.boolean(),
  })
  .strict();
const providerIssueSchema = z
  .object({
    kind: z.literal(AGENT_EXECUTION_ISSUE_KIND),
    code: providerIssueCodeSchema,
    category: z.literal("provider"),
    recoverable: z.literal(true),
    retry_scope: z.literal("current_step"),
    facts: issueFactsSchema,
  })
  .strict();
const executionPauseSchema = z
  .object({
    kind: z.literal(AGENT_TASK_EXECUTION_PAUSE_KIND),
    classification: pauseClassificationSchema,
    step_id: z.string().trim().min(1).max(200),
    attempt: z.number().int().min(0),
    created_at: z.string().datetime(),
    issue: providerIssueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedCode = providerIssueCode(value.classification);
    if (value.issue.code !== expectedCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue", "code"],
        message: "Provider issue code does not match pause classification",
      });
    }
    if (
      value.issue.facts.step_id !== value.step_id ||
      value.issue.facts.attempt !== value.attempt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue", "facts"],
        message: "Provider issue facts do not match the paused Step",
      });
    }
    const retriesExpected = ![
      "provider_protocol",
      "provider_structured_output",
      "provider_configuration",
    ].includes(value.classification);
    if (value.issue.facts.automatic_retries_exhausted !== retriesExpected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue", "facts", "automatic_retries_exhausted"],
        message:
          "Provider retry exhaustion does not match pause classification",
      });
    }
  });

const legacyExecutionPauseSchema = z
  .object({
    kind: z.literal(AGENT_TASK_EXECUTION_PAUSE_KIND),
    classification: z.enum([
      "provider_capacity",
      "provider_network",
      "provider_protocol",
    ]),
    step_id: z.string().trim().min(1).max(200),
    attempt: z.number().int().min(0),
    created_at: z.string().datetime(),
  })
  .strict();

export type AgentExecutionIssueV1 = z.infer<typeof providerIssueSchema>;
export type AgentTaskExecutionPauseCheckpointV1 = z.infer<
  typeof executionPauseSchema
>;

function providerIssueCode(
  classification: AgentTaskExecutionPauseClassification,
): AgentExecutionIssueV1["code"] {
  switch (classification) {
    case "provider_capacity":
      return "provider_capacity_exhausted";
    case "provider_timeout":
      return "provider_timeout_exhausted";
    case "provider_network":
      return "provider_network_exhausted";
    case "provider_protocol":
      return "provider_protocol_incompatible";
    case "provider_structured_output":
      return "provider_structured_output_invalid";
    case "provider_configuration":
      return "provider_configuration_required";
  }
}

export function providerPauseClassificationForRetry(
  classification: AgentTaskRetryClassification,
): AgentTaskExecutionPauseClassification {
  if (classification === "timeout") return "provider_timeout";
  if (classification === "network") return "provider_network";
  return "provider_capacity";
}

export function providerPauseSummary(
  classification: AgentTaskExecutionPauseClassification,
  automaticRetries: number,
) {
  switch (classification) {
    case "provider_protocol":
      return "The selected model did not complete the required provider tool protocol. This step is paused without discarding existing work; resume it or choose a compatible model.";
    case "provider_structured_output":
      return "The selected model returned an invalid structured verifier result. This step is paused without discarding existing work; resume it or choose a model with reliable structured output.";
    case "provider_configuration":
      return "The selected provider cannot run this step because its API key, balance, or model access needs attention. Existing work is preserved; update Model settings or choose another configured model, then resume this step.";
    case "provider_timeout":
      return `The selected model timed out after ${automaticRetries} automatic retries. This step is paused without discarding existing work; resume it when the provider responds normally.`;
    case "provider_network":
      return `The provider connection remained unavailable after ${automaticRetries} automatic retries. This step is paused without discarding existing work; resume it when connectivity is restored.`;
    case "provider_capacity":
      return `The selected model remained unavailable after ${automaticRetries} automatic retries. This step is paused without discarding existing work; resume it when the provider is available.`;
  }
}

export function buildAgentTaskExecutionPauseCheckpoint(input: {
  classification: AgentTaskExecutionPauseClassification;
  stepId: string;
  attempt: number;
  createdAt: string;
}): AgentTaskExecutionPauseCheckpointV1 {
  return executionPauseSchema.parse({
    kind: AGENT_TASK_EXECUTION_PAUSE_KIND,
    classification: input.classification,
    step_id: input.stepId,
    attempt: input.attempt,
    created_at: input.createdAt,
    issue: {
      kind: AGENT_EXECUTION_ISSUE_KIND,
      code: providerIssueCode(input.classification),
      category: "provider",
      recoverable: true,
      retry_scope: "current_step",
      facts: {
        step_id: input.stepId,
        attempt: input.attempt,
        automatic_retries_exhausted: ![
          "provider_protocol",
          "provider_structured_output",
          "provider_configuration",
        ].includes(input.classification),
      },
    },
  });
}

export function mergeAgentTaskProviderPauseCheckpoint(input: {
  previous: unknown;
  currentStep?: { id: string; attempt: number } | null;
  classification: AgentTaskExecutionPauseClassification;
  summary: string;
  createdAt: string;
}) {
  const previous =
    input.previous &&
    typeof input.previous === "object" &&
    !Array.isArray(input.previous)
      ? (input.previous as Record<string, unknown>)
      : {};
  const retainedStepId =
    typeof previous.step_id === "string" && previous.step_id.trim()
      ? previous.step_id
      : "planner";
  const retainedAttempt =
    typeof previous.iteration === "number" &&
    Number.isInteger(previous.iteration) &&
    previous.iteration >= 0
      ? previous.iteration
      : 0;
  const stepId = input.currentStep?.id ?? retainedStepId;
  const attempt = input.currentStep?.attempt ?? retainedAttempt;
  return {
    ...previous,
    step_id: stepId,
    iteration: attempt,
    summary: input.summary,
    created_at: input.createdAt,
    execution_pause: buildAgentTaskExecutionPauseCheckpoint({
      classification: input.classification,
      stepId,
      attempt,
      createdAt: input.createdAt,
    }),
  };
}

export function readAgentTaskExecutionPauseCheckpoint(
  value: unknown,
): AgentTaskExecutionPauseCheckpointV1 | null {
  const current = executionPauseSchema.safeParse(value);
  if (current.success) return current.data;

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "issue")
  ) {
    return null;
  }
  const legacy = legacyExecutionPauseSchema.safeParse(value);
  if (!legacy.success) return null;
  return buildAgentTaskExecutionPauseCheckpoint({
    classification: legacy.data.classification,
    stepId: legacy.data.step_id,
    attempt: legacy.data.attempt,
    createdAt: legacy.data.created_at,
  });
}
