export type V1RuntimeStatus =
  | "queued"
  | "working"
  | "blocked"
  | "review_needed"
  | "waiting_for_approval"
  | "done"
  | "failed"
  | "cancelled";

export type V1RuntimeToolCall = {
  id: string;
  name: string;
  started_at: string;
  ended_at?: string;
  status: "started" | "succeeded" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string;
};

export type V1RuntimeTraceEvent = {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  metadata?: Record<string, unknown>;
};

export type V1RuntimeProviderDecision = {
  allowed: boolean;
  reason: string;
  externalCall: boolean;
  provider: string;
  model: string;
  privacyMode: string;
};

export type V1RuntimeAgentRun = {
  id: string;
  matter_id: string;
  agent_id: string;
  started_at: string;
  ended_at?: string;
  status: V1RuntimeStatus;
  tool_calls: V1RuntimeToolCall[];
  trace_events: V1RuntimeTraceEvent[];
  model?: string;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  errors: string[];
};

export type V1RuntimeAuditEvent = {
  id: string;
  matter_id: string;
  actor_type: "human" | "agent" | "system";
  actor_id: string;
  action: string;
  artifact_id?: string;
  artifact_type?: string;
  before_hash?: string;
  after_hash?: string;
  timestamp: string;
};

export type V1RuntimePersistenceInput = {
  userId: string;
  matterId: string;
  workflow: string;
  goal: string;
  run: V1RuntimeAgentRun;
  auditEvents: V1RuntimeAuditEvent[];
  providerDecision?: V1RuntimeProviderDecision;
  now?: string;
};

export type PersistedV1AgentRunRow = {
  id: string;
  matter_id: string;
  user_id: string;
  workflow: string;
  goal: string;
  status: "queued" | "running" | "blocked" | "needs_human" | "completed" | "failed" | "cancelled";
  current_step_key: string | null;
  model_profile: string | null;
  storage_driver: "local";
  budget: Record<string, unknown>;
  metadata: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PersistedV1AgentStepRow = {
  id: string;
  run_id: string;
  matter_id: string;
  user_id: string;
  step_key: string;
  title: string;
  sequence: number;
  status: "pending" | "running" | "completed" | "needs_human" | "failed" | "skipped";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  validation_errors: unknown[];
  metrics: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export type PersistedV1ToolCallRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  matter_id: string;
  user_id: string;
  tool_name: string;
  risk_level: "low" | "medium" | "high";
  status: "pending" | "running" | "completed" | "failed" | "requires_confirmation";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  metrics: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export type PersistedV1AuditEventRow = {
  id: string;
  matter_id: string;
  user_id: string;
  actor: "system" | "agent" | "human";
  action: string;
  workflow_version: string;
  model: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type PersistedV1HumanCheckpointRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  matter_id: string;
  user_id: string;
  checkpoint_type: "external_model_call";
  status: "open";
  prompt: string;
  decision: null;
  requested_payload: Record<string, unknown>;
  decision_payload: Record<string, unknown>;
  decided_by: null;
  decided_at: null;
  created_at: string;
};

export type V1RuntimePersistencePlan = {
  agentRun: PersistedV1AgentRunRow;
  steps: PersistedV1AgentStepRow[];
  toolCalls: PersistedV1ToolCallRow[];
  auditEvents: PersistedV1AuditEventRow[];
  humanCheckpoints: PersistedV1HumanCheckpointRow[];
  blockers: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runtimeStatusToPersisted(status: V1RuntimeStatus): PersistedV1AgentRunRow["status"] {
  if (status === "working") return "running";
  if (status === "done") return "completed";
  if (status === "waiting_for_approval" || status === "review_needed") {
    return "needs_human";
  }
  return status;
}

function toolStatusToPersisted(status: V1RuntimeToolCall["status"]): PersistedV1ToolCallRow["status"] {
  if (status === "started") return "running";
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  return "requires_confirmation";
}

function traceStatusToPersisted(
  event: V1RuntimeTraceEvent,
  runStatus: V1RuntimeStatus,
): PersistedV1AgentStepRow["status"] {
  if (event.level === "error") return "failed";
  const phase = String(event.metadata?.phase ?? "");
  if (phase === "gate" && runStatus === "blocked") return "failed";
  if (phase === "report" && runStatus === "working") return "running";
  return "completed";
}

function approvalNeeded(decision: V1RuntimeProviderDecision | undefined) {
  return Boolean(
    decision &&
      decision.externalCall &&
      !decision.allowed &&
      (decision.privacyMode === "private" || decision.privacyMode === "sensitive"),
  );
}

export function createV1RuntimePersistencePlan(
  input: V1RuntimePersistenceInput,
): V1RuntimePersistencePlan {
  const timestamp = input.now ?? input.run.ended_at ?? input.run.started_at;
  const currentPhase =
    input.run.trace_events.at(-1)?.metadata?.phase ??
    input.run.trace_events.at(-1)?.id ??
    null;
  const needsApproval = approvalNeeded(input.providerDecision);
  const blockers = [
    ...input.run.errors,
    ...(needsApproval
      ? ["Persisted human approval is required before any private/sensitive external model call."]
      : []),
  ];

  const steps = input.run.trace_events.map((event, index) => ({
    id: event.id,
    run_id: input.run.id,
    matter_id: input.matterId,
    user_id: input.userId,
    step_key: String(event.metadata?.phase ?? event.id),
    title: event.message,
    sequence: index + 1,
    status: traceStatusToPersisted(event, input.run.status),
    input: {
      traceEventId: event.id,
      level: event.level,
    },
    output: {
      message: event.message,
      metadata: event.metadata ?? {},
    },
    validation_errors: event.level === "error" ? [event.message] : [],
    metrics: {},
    started_at: event.timestamp,
    completed_at: event.timestamp,
    created_at: event.timestamp,
  }));
  const stepIdsByPhase = new Map(steps.map((step) => [step.step_key, step.id]));

  return {
    agentRun: {
      id: input.run.id,
      matter_id: input.matterId,
      user_id: input.userId,
      workflow: input.workflow,
      goal: input.goal,
      status: runtimeStatusToPersisted(input.run.status),
      current_step_key: currentPhase ? String(currentPhase) : null,
      model_profile: input.run.model ?? null,
      storage_driver: "local",
      budget: {
        tokenUsage: input.run.token_usage ?? null,
      },
      metadata: {
        v1Runtime: {
          agentId: input.run.agent_id,
          providerDecision: input.providerDecision ?? null,
          externalApprovalRequired: needsApproval,
          blockers,
        },
      },
      started_at: input.run.started_at,
      completed_at: input.run.ended_at ?? null,
      created_at: input.run.started_at,
      updated_at: timestamp,
    },
    steps,
    toolCalls: input.run.tool_calls.map((call) => {
      const phase = String(record(call.output).phase ?? record(call.input).phase ?? "");
      return {
        id: call.id,
        run_id: input.run.id,
        step_id: stepIdsByPhase.get(phase) ?? null,
        matter_id: input.matterId,
        user_id: input.userId,
        tool_name: call.name,
        risk_level:
          call.name === "v1_model_call" && input.providerDecision?.externalCall
            ? "high"
            : "medium",
        status: toolStatusToPersisted(call.status),
        input: record(call.input),
        output: record(call.output),
        error: call.error ?? null,
        metrics: {},
        started_at: call.started_at,
        completed_at: call.ended_at ?? null,
        created_at: call.started_at,
      };
    }),
    auditEvents: input.auditEvents.map((event) => ({
      id: event.id,
      matter_id: input.matterId,
      user_id: input.userId,
      actor: event.actor_type,
      action: event.action,
      workflow_version: "aletheia-v1-llm-runtime",
      model: input.run.model ?? null,
      details: {
        actorId: event.actor_id,
        artifactId: event.artifact_id ?? null,
        artifactType: event.artifact_type ?? null,
        beforeHash: event.before_hash ?? null,
        afterHash: event.after_hash ?? null,
      },
      created_at: event.timestamp,
    })),
    humanCheckpoints: needsApproval && input.providerDecision
      ? [
          {
            id: `${input.run.id}-external-model-approval`,
            run_id: input.run.id,
            step_id: stepIdsByPhase.get("gate") ?? null,
            matter_id: input.matterId,
            user_id: input.userId,
            checkpoint_type: "external_model_call",
            status: "open",
            prompt:
              "Approve external model use for this private or sensitive Aletheia matter before dispatch.",
            decision: null,
            requested_payload: {
              providerDecision: input.providerDecision,
              requiredAction:
                "Confirm provider, model, privacy mode, budget, and data-sharing approval before retrying.",
            },
            decision_payload: {},
            decided_by: null,
            decided_at: null,
            created_at: timestamp,
          },
        ]
      : [],
    blockers,
  };
}
