import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  CreateWorkflowRequestSchema,
  SafeStructuredValueSchema,
  StructuredErrorSchema,
  UpdateWorkflowRequestSchema,
  WorkspaceIdSchema,
  WorkflowSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import type { PageRequest } from "../pagination";
import type { EnqueueWorkspaceJobInput, JobEnqueuer } from "./jobEnqueuer";
import {
  WorkflowsRepository,
  type NewWorkflowRecord,
  type NewWorkflowExecutionSnapshot,
  type NewWorkflowRunRecord,
  type PreparedWorkflowRun,
  type SystemWorkflowTemplate,
  type WorkflowExecutionSnapshot,
  type WorkflowRunDetail,
} from "../repositories/workflows";
import type {
  StructuredError,
  Workflow,
  WorkflowColumn,
  WorkflowStep,
  WorkspaceJson,
} from "../types";
import {
  assertInferenceAllowed,
  type InferencePolicyEnforcementPort,
} from "../inferencePolicy";

export const DEFAULT_WORKFLOW_MAX_STEPS = 25;
export const HARD_WORKFLOW_MAX_STEPS = 100;
export const DEFAULT_WORKFLOW_MAX_MODEL_CALLS = 20;
export const HARD_WORKFLOW_MAX_MODEL_CALLS = 100;
export const MAX_WORKFLOW_STEP_ATTEMPTS = 3;
const DEFAULT_WORKFLOW_LANGUAGE = "English";
const DEFAULT_WORKFLOW_PRACTICE = "General Transactions";
const DEFAULT_WORKFLOW_JURISDICTIONS = ["General"] as const;

export type WorkflowExecutionLimits = {
  maxSteps?: number;
  maxModelCalls?: number;
};

export type WorkflowsServiceOptions = Readonly<{
  inferencePolicy?: InferencePolicyEnforcementPort;
}>;

/**
 * Callbacks supplied by the shared fenced Jobs implementation.  They execute
 * inside the workflow repository's BEGIN IMMEDIATE transaction; the workflow
 * layer never reproduces lease predicates or scheduler logic.
 */
export type WorkflowClaimCallbacks = {
  assert: () => { id: string };
  finishComplete: (result: WorkspaceJson) => { id: string };
  finishFailure: (error: StructuredError) => { id: string };
};

const PrepareWorkflowRunRequestSchema = z
  .object({
    projectId: WorkspaceIdSchema.optional(),
    modelProfileId: WorkspaceIdSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    inputBinding: SafeStructuredValueSchema.optional(),
  })
  .strict();

// The public schema adds a non-empty refinement. Mike compatibility fields
// are resolved only after the durable workflow type is known, so first check
// the exact same strict object shape without rejecting skill_md-only patches.
const CanonicalWorkflowUpdateFieldsSchema =
  UpdateWorkflowRequestSchema.innerType();

/**
 * Narrow internal bridge used only by workflowCompatibility's Mike parser.
 * The public Workspace update contract remains strict; these fields let the
 * service resolve assistant-vs-tabular ownership before materialising the
 * corresponding canonical update.
 */
const MikeWorkflowUpdateCompatibilitySchema = z
  .object({
    mikeSkillMarkdown: z.string().max(100_000).optional(),
    mikeTabularColumnFormats: z
      .record(
        z.enum([
          "text",
          "bulleted_list",
          "number",
          "currency",
          "yes_no",
          "date",
          "tag",
          "percentage",
          "monetary_amount",
        ]),
      )
      .optional(),
    mikeTabularColumnTags: z
      .record(z.array(z.string().trim().min(1).max(160)).max(100))
      .optional(),
  })
  .strict();
type MikeWorkflowUpdateCompatibility = z.infer<
  typeof MikeWorkflowUpdateCompatibilitySchema
>;

function splitMikeWorkflowUpdate(
  value: unknown,
  existing: Workflow,
): {
  input: z.infer<typeof UpdateWorkflowRequestSchema>;
  tabularMetadata: Record<string, WorkspaceJson> | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      input: UpdateWorkflowRequestSchema.parse(value),
      tabularMetadata: null,
    };
  }
  const fields = value as Record<string, unknown>;
  const {
    mikeSkillMarkdown,
    mikeTabularColumnFormats,
    mikeTabularColumnTags,
    ...canonicalCandidate
  } = fields;
  const compatibility: MikeWorkflowUpdateCompatibility =
    MikeWorkflowUpdateCompatibilitySchema.parse({
      ...(Object.hasOwn(fields, "mikeSkillMarkdown")
        ? { mikeSkillMarkdown }
        : {}),
      ...(Object.hasOwn(fields, "mikeTabularColumnFormats")
        ? { mikeTabularColumnFormats }
        : {}),
      ...(Object.hasOwn(fields, "mikeTabularColumnTags")
        ? { mikeTabularColumnTags }
        : {}),
    });
  const canonicalInput =
    CanonicalWorkflowUpdateFieldsSchema.parse(canonicalCandidate);
  const hasTabularCompatibility =
    compatibility.mikeTabularColumnFormats !== undefined ||
    compatibility.mikeTabularColumnTags !== undefined;
  if (existing.type === "assistant") {
    if (hasTabularCompatibility) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Assistant workflows do not accept tabular column metadata.",
      );
    }
    return {
      // Enforce the usual non-empty canonical update only after a Mike
      // skill_md is materialised as assistant skillMarkdown.
      input: UpdateWorkflowRequestSchema.parse({
        ...canonicalInput,
        ...(compatibility.mikeSkillMarkdown === undefined
          ? {}
          : { skillMarkdown: compatibility.mikeSkillMarkdown }),
      }),
      tabularMetadata: null,
    };
  }
  if (
    compatibility.mikeSkillMarkdown === undefined &&
    !hasTabularCompatibility
  ) {
    return {
      input: UpdateWorkflowRequestSchema.parse(canonicalInput),
      tabularMetadata: null,
    };
  }
  return {
    // A Tabular skill_md/format/tags patch is independently meaningful.  The
    // compatibility schema has already required its bounded fields; it does
    // not need a redundant canonical field merely to pass this bridge.
    input: canonicalInput,
    tabularMetadata: {
      ...(compatibility.mikeSkillMarkdown === undefined
        ? {}
        : { mikeTabularSkillMarkdown: compatibility.mikeSkillMarkdown }),
      ...(compatibility.mikeTabularColumnFormats === undefined
        ? {}
        : {
            mikeTabularColumnFormats: compatibility.mikeTabularColumnFormats,
          }),
      ...(compatibility.mikeTabularColumnTags === undefined
        ? {}
        : { mikeTabularColumnTags: compatibility.mikeTabularColumnTags }),
    },
  };
}

export type PrepareWorkflowRunRequest = z.infer<
  typeof PrepareWorkflowRunRequestSchema
>;

export type MikeBuiltinWorkflowSeed = Omit<
  SystemWorkflowTemplate,
  "workflow"
> & {
  upstreamId: string;
  workflow: Omit<NewWorkflowRecord, "id" | "isBuiltin" | "now" | "columns"> & {
    columns: Array<
      Pick<WorkflowColumn, "key" | "title" | "outputType" | "prompt"> & {
        enumValues?: string[];
      }
    >;
  };
};

const sensitiveToken =
  /(?:bearer\s+)[a-z0-9._~+\/-]+|\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi;
const localPath = /(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g;

function redactText(value: string) {
  return value
    .replace(sensitiveToken, "[redacted]")
    .replace(localPath, "[redacted-path]");
}

function sanitizeJson(value: unknown): WorkspaceJson {
  const parsed = SafeStructuredValueSchema.parse(value);
  const walk = (item: WorkspaceJson): WorkspaceJson => {
    if (typeof item === "string") return redactText(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, walk(child)]),
      );
    }
    return item;
  };
  return walk(parsed);
}

function sanitizeError(value: unknown): StructuredError {
  const parsed = StructuredErrorSchema.parse(value);
  return StructuredErrorSchema.parse({
    ...parsed,
    message: redactText(parsed.message),
    details:
      parsed.details == null
        ? null
        : Object.fromEntries(
            Object.entries(parsed.details).map(([key, item]) => [
              key,
              typeof item === "string" ? redactText(item) : item,
            ]),
          ),
  });
}

function requirePositiveLimit(
  value: number | undefined,
  fallback: number,
  hardLimit: number,
  label: string,
) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > hardLimit) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} must be an integer between 1 and ${hardLimit}.`,
    );
  }
  return resolved;
}

function assertStepSemantics(type: Workflow["type"], steps: WorkflowStep[]) {
  if (steps.length > HARD_WORKFLOW_MAX_STEPS) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "A workflow cannot exceed 100 steps.",
    );
  }
  if (
    type === "assistant" &&
    steps.some((step) => step.kind === "tabular_column")
  ) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Assistant workflows cannot contain tabular-column steps.",
    );
  }
  if (type === "tabular" && steps.some((step) => step.kind === "output")) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Tabular workflows cannot contain Assistant output steps.",
    );
  }
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (!step.id) continue;
    if (stepIds.has(step.id)) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Workflow step identifiers must be unique.",
      );
    }
    stepIds.add(step.id);
  }
  const outputs = steps
    .map((step, ordinal) => ({ step, ordinal }))
    .filter(({ step }) => step.kind === "output");
  if (outputs.length > 1) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Assistant workflows can contain at most one output step.",
    );
  }
  const output = outputs[0];
  if (output && output.ordinal !== steps.length - 1) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "The output step must be the final workflow step.",
    );
  }
  if (
    output &&
    !steps.slice(0, output.ordinal).some((step) => step.kind === "prompt")
  ) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "The output step requires an earlier prompt step.",
    );
  }
}

function stableSyntheticStepUuid(workflowId: string, label: string) {
  const hex = createHash("sha256")
    .update(`vera-workflow-step-v1:${workflowId}:${label}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function materializedExecutionSteps(workflow: Workflow): WorkflowStep[] {
  if (workflow.type !== "assistant") return workflow.steps;
  if (workflow.steps.length > 0) return workflow.steps;
  const prompt = workflow.skillMarkdown.trim();
  return prompt
    ? [
        {
          id: stableSyntheticStepUuid(workflow.id, "materialized-skill"),
          kind: "prompt",
          title: "Workflow instructions",
          prompt,
        },
      ]
    : [];
}

function modelCallCount(steps: readonly WorkflowStep[]) {
  return steps.filter((step) => step.kind === "prompt").length;
}

function assertExecutableWorkflow(workflow: Workflow) {
  if (workflow.type === "tabular") {
    throw new WorkspaceApiError(
      412,
      "PRECONDITION_FAILED",
      "Tabular workflows must run through the Tabular review runtime.",
    );
  }
  if (materializedExecutionSteps(workflow).length === 0) {
    throw new WorkspaceApiError(
      412,
      "PRECONDITION_FAILED",
      "Workflow draft has no executable skill, columns, or steps.",
    );
  }
}

function snapshotSkillMarkdown(workflow: Workflow): string {
  if (workflow.type === "assistant") return workflow.skillMarkdown;
  const value = workflow.metadata.mikeTabularSkillMarkdown;
  return typeof value === "string" ? value : "";
}

function canonicalJson(value: WorkspaceJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value: WorkspaceJson) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertSnapshotTextIsSafe(value: WorkspaceJson): void {
  const visit = (entry: WorkspaceJson): void => {
    if (typeof entry === "string") {
      sensitiveToken.lastIndex = 0;
      localPath.lastIndex = 0;
      if (sensitiveToken.test(entry) || localPath.test(entry)) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Workflow execution snapshots cannot contain secrets or local paths.",
        );
      }
      sensitiveToken.lastIndex = 0;
      localPath.lastIndex = 0;
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry && typeof entry === "object") {
      Object.values(entry).forEach(visit);
    }
  };
  visit(value);
}

function stableBuiltinUuid(upstreamId: string) {
  const hex = createHash("sha256")
    .update(`vera-mike-builtin-v1:${upstreamId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function snapshotExecutionLimits(snapshot: WorkflowExecutionSnapshot) {
  const config = snapshot.config;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.execution === null ||
    typeof config.execution !== "object" ||
    Array.isArray(config.execution)
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Workflow execution snapshot limits are invalid.",
    );
  }
  const execution = config.execution;
  return {
    maxSteps: requirePositiveLimit(
      typeof execution.maxSteps === "number" ? execution.maxSteps : undefined,
      DEFAULT_WORKFLOW_MAX_STEPS,
      HARD_WORKFLOW_MAX_STEPS,
      "maxSteps",
    ),
    maxModelCalls: requirePositiveLimit(
      typeof execution.maxModelCalls === "number"
        ? execution.maxModelCalls
        : undefined,
      DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
      HARD_WORKFLOW_MAX_MODEL_CALLS,
      "maxModelCalls",
    ),
  };
}

export class WorkflowsService {
  constructor(
    private readonly repository: WorkflowsRepository,
    private readonly jobs: JobEnqueuer,
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
    private readonly options: WorkflowsServiceOptions = {},
  ) {}

  private now() {
    return this.clock().toISOString();
  }

  list(
    request: PageRequest & {
      type?: Workflow["type"];
      projectId?: string | null;
      includeArchived?: boolean;
      includeHidden?: boolean;
    } = {},
  ) {
    return this.repository.list(request);
  }

  get(id: string) {
    return this.repository.require(id);
  }

  /**
   * Client definition read boundary. Explicit legacy steps receive stable
   * deterministic UUIDs that the next definition PUT persists. A Mike
   * skill-only workflow receives a virtual prompt until that intentional save.
   */
  getAssistantDefinition(id: string) {
    const existing = this.repository.require(id);
    if (existing.type !== "assistant") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Only Assistant workflows have client step definitions.",
      );
    }
    if (existing.isBuiltin) {
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "System workflows are immutable; create a local copy to edit steps.",
      );
    }
    if (existing.steps.length === 0) {
      return {
        ...existing,
        steps: materializedExecutionSteps(existing),
      };
    }
    const used = new Set<string>();
    let changed = false;
    const steps = existing.steps.map((step, ordinal) => {
      const id = step.id;
      if (id && !used.has(id)) {
        used.add(id);
        return step;
      }
      let suffix = 0;
      let generated = stableSyntheticStepUuid(
        existing.id,
        `legacy-${ordinal}-${suffix}`,
      );
      while (used.has(generated)) {
        suffix += 1;
        generated = stableSyntheticStepUuid(
          existing.id,
          `legacy-${ordinal}-${suffix}`,
        );
      }
      used.add(generated);
      changed = true;
      return { ...step, id: generated };
    });
    if (!changed) return existing;
    // GET remains read-only. The deterministic IDs survive restarts and are
    // persisted by the next full definition PUT from the client.
    return { ...existing, steps };
  }

  updateAssistantDefinition(
    id: string,
    input: {
      projectId: string | null;
      title: string;
      description: string | null;
      steps: WorkflowStep[];
    },
  ) {
    const existing = this.repository.require(id);
    if (existing.type !== "assistant") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Only Assistant workflows have client step definitions.",
      );
    }
    if (existing.isBuiltin) {
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "System workflows are immutable; create a local copy to edit steps.",
      );
    }
    if (input.steps.some((step) => !step.id)) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Client-authored workflow steps require stable identifiers.",
      );
    }
    return this.update(id, {
      ...input,
      ...(existing.steps.length === 0 &&
      existing.skillMarkdown.trim() &&
      input.steps.length > 0
        ? { skillMarkdown: "" }
        : {}),
    });
  }

  resolveMikeWorkflowId(id: string) {
    return this.repository.resolveMikeWorkflowId(id);
  }

  getMikeBuiltinMapping(workflowId: string) {
    return this.repository.getSystemWorkflowMappingByWorkflowId(workflowId);
  }

  /** Seeded templates are supplied by composition from the pinned Mike source. */
  seedMikeBuiltin(seed: MikeBuiltinWorkflowSeed) {
    if (!/^builtin-[a-z0-9-]+$/.test(seed.upstreamId)) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Invalid Mike builtin workflow identifier.",
      );
    }
    const id = stableBuiltinUuid(seed.upstreamId);
    const columns: WorkflowColumn[] =
      seed.workflow.type === "tabular"
        ? seed.workflow.columns.map((column, ordinal) => ({
            id: this.idFactory(),
            workflowId: id,
            key: column.key,
            title: column.title,
            outputType: column.outputType,
            prompt: column.prompt,
            enumValues: column.enumValues ?? null,
            ordinal,
          }))
        : [];
    const workflow: NewWorkflowRecord = {
      ...seed.workflow,
      id,
      columns,
      isBuiltin: true,
      now: this.now(),
    };
    assertStepSemantics(workflow.type, workflow.steps);
    return this.repository.seedSystemWorkflow({
      ...seed,
      workflow,
    });
  }

  create(value: unknown) {
    const input = CreateWorkflowRequestSchema.parse(value);
    assertStepSemantics(input.type, input.steps);
    if (input.projectId) this.repository.requireActiveProject(input.projectId);
    const now = this.now();
    const id = this.idFactory();
    const columns: WorkflowColumn[] =
      input.type === "tabular"
        ? input.columns.map((column, ordinal) => ({
            id: this.idFactory(),
            workflowId: id,
            key: column.key,
            title: column.title,
            outputType: column.outputType,
            prompt: column.prompt,
            enumValues: column.enumValues ?? null,
            ordinal,
          }))
        : [];
    return this.repository.create({
      id,
      type: input.type,
      projectId: input.projectId ?? null,
      title: input.title,
      description: input.description ?? null,
      skillMarkdown: input.type === "assistant" ? input.skillMarkdown : "",
      steps: input.steps,
      columns,
      language: input.language ?? DEFAULT_WORKFLOW_LANGUAGE,
      practice: input.practice ?? DEFAULT_WORKFLOW_PRACTICE,
      jurisdictions: input.jurisdictions ?? [...DEFAULT_WORKFLOW_JURISDICTIONS],
      metadata: input.metadata ?? {},
      isBuiltin: false,
      now,
    });
  }

  update(id: string, value: unknown) {
    const existing = this.repository.require(id);
    const { input, tabularMetadata } = splitMikeWorkflowUpdate(value, existing);
    if (existing.isBuiltin) {
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "System workflows are immutable; hide them instead.",
      );
    }
    if (existing.type === "assistant" && input.columns !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Assistant workflows do not define tabular columns.",
      );
    }
    if (existing.type === "tabular" && input.skillMarkdown !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Tabular workflows do not define assistant skill markdown.",
      );
    }
    const steps = input.steps ?? existing.steps;
    assertStepSemantics(existing.type, steps);
    const projectId =
      input.projectId === undefined ? existing.projectId : input.projectId;
    if (projectId) this.repository.requireActiveProject(projectId);
    const now = this.now();
    let candidate: Workflow;
    if (existing.type === "assistant") {
      candidate = {
        ...existing,
        projectId,
        title: input.title ?? existing.title,
        description:
          input.description === undefined
            ? existing.description
            : input.description,
        status: input.status ?? existing.status,
        skillMarkdown: input.skillMarkdown ?? existing.skillMarkdown,
        steps,
        language: input.language ?? existing.language,
        practice: input.practice ?? existing.practice,
        jurisdictions: input.jurisdictions ?? existing.jurisdictions,
        metadata: input.metadata ?? existing.metadata,
        updatedAt: now,
      };
    } else {
      const existingIds = new Map(
        existing.columns.map((column) => [column.key, column.id]),
      );
      const columns = input.columns
        ? input.columns.map((column, ordinal) => ({
            id: existingIds.get(column.key) ?? this.idFactory(),
            workflowId: existing.id,
            key: column.key,
            title: column.title,
            outputType: column.outputType,
            prompt: column.prompt,
            enumValues: column.enumValues ?? null,
            ordinal,
          }))
        : existing.columns;
      candidate = {
        ...existing,
        projectId,
        title: input.title ?? existing.title,
        description:
          input.description === undefined
            ? existing.description
            : input.description,
        status: input.status ?? existing.status,
        columns,
        steps,
        language: input.language ?? existing.language,
        practice: input.practice ?? existing.practice,
        jurisdictions: input.jurisdictions ?? existing.jurisdictions,
        metadata: tabularMetadata
          ? {
              ...existing.metadata,
              ...(input.metadata ?? {}),
              ...tabularMetadata,
            }
          : (input.metadata ?? existing.metadata),
        updatedAt: now,
      };
    }
    return this.repository.replace(WorkflowSchema.parse(candidate), now);
  }

  archive(id: string) {
    if (this.repository.require(id).isBuiltin) {
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "System workflows are immutable; hide them instead.",
      );
    }
    return this.repository.archive(id, this.now());
  }

  delete(id: string) {
    if (this.repository.require(id).isBuiltin) {
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "System workflows cannot be deleted; hide them instead.",
      );
    }
    this.repository.delete(id);
  }

  hide(id: string) {
    this.repository.hide(id, this.idFactory(), this.now());
  }

  unhide(id: string) {
    this.repository.unhide(id);
  }

  isHidden(id: string) {
    this.repository.require(id);
    return this.repository.isHidden(id);
  }

  listHiddenMikeWorkflowIds() {
    return this.repository.listHiddenWorkflowIds().map((id) => {
      const mapping = this.repository.getSystemWorkflowMappingByWorkflowId(id);
      return mapping?.upstreamId ?? id;
    });
  }

  hideMikeWorkflow(id: string) {
    this.hide(this.resolveMikeWorkflowId(id));
  }

  unhideMikeWorkflow(id: string) {
    this.unhide(this.resolveMikeWorkflowId(id));
  }

  listRuns(workflowId: string, request: PageRequest = {}) {
    return this.repository.listRuns(workflowId, request);
  }

  getRun(id: string) {
    return this.repository.requireRunDetail(id);
  }

  reconcileTerminalJobs() {
    return this.repository.reconcileTerminalJobRuns(this.now());
  }

  getExecutionSnapshot(runId: string) {
    return this.repository.requireExecutionSnapshot(runId);
  }

  requireExecutionSnapshotReady(runId: string) {
    const snapshot = this.repository.requireExecutionSnapshot(runId);
    if (modelCallCount(snapshot.steps) > 0) {
      this.repository.requireExecutionModelProfileSnapshot(snapshot);
    }
    return snapshot;
  }

  startRun(
    workflowId: string,
    value: unknown,
    limits: WorkflowExecutionLimits = {},
  ): WorkflowRunDetail {
    // Compatibility name only: P1 never creates a run without a durable v6
    // snapshot and an explicit idempotency key.
    return this.prepareRun(workflowId, value, limits).detail;
  }

  /**
   * P1 runtime entry point.  Unlike the legacy helper above it records the
   * complete immutable execution snapshot and preserves the caller's
   * idempotency key all the way through the enqueue transaction.
   */
  prepareRun(
    workflowId: string,
    value: unknown,
    limits: WorkflowExecutionLimits = {},
  ): PreparedWorkflowRun {
    const request = PrepareWorkflowRunRequestSchema.parse(value);
    const workflow = this.repository.require(workflowId);
    if (workflow.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Workflow is not active.");
    }
    assertExecutableWorkflow(workflow);
    const executionSteps = materializedExecutionSteps(workflow);
    const defaults = this.repository.workspaceDefaults();
    if (
      workflow.projectId !== null &&
      request.projectId !== undefined &&
      request.projectId !== workflow.projectId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A project-bound workflow must run in its bound project.",
      );
    }
    const projectId =
      workflow.projectId ??
      (request.projectId !== undefined
        ? request.projectId
        : defaults.defaultProjectId);
    const project = projectId
      ? this.repository.requireActiveProject(projectId)
      : null;
    const configuredStepProfiles = [
      ...new Set(
        executionSteps.flatMap((step) =>
          step.kind === "prompt" && step.modelProfileId
            ? [step.modelProfileId]
            : [],
        ),
      ),
    ];
    if (configuredStepProfiles.length > 1) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "All prompt steps must use the same immutable run model profile.",
      );
    }
    const modelCalls = modelCallCount(executionSteps);
    const requiresModel = modelCalls > 0;
    const resolvedModelProfileId =
      request.modelProfileId ??
      configuredStepProfiles[0] ??
      project?.defaultModelProfileId ??
      defaults.defaultModelProfileId;
    const modelProfileId = requiresModel ? resolvedModelProfileId : null;
    if (requiresModel && !modelProfileId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Configure an enabled project or workspace default model profile before running a workflow.",
      );
    }
    if (modelProfileId) {
      this.repository.requireEnabledModelProfile(modelProfileId);
    }
    const mismatchedStep = executionSteps.find(
      (step) =>
        step.kind === "prompt" &&
        step.modelProfileId !== undefined &&
        step.modelProfileId !== modelProfileId,
    );
    if (mismatchedStep) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A prompt step model profile must match the immutable run model profile.",
      );
    }
    if (requiresModel) {
      if (!this.options.inferencePolicy) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Inference policy runtime is unavailable.",
        );
      }
      assertInferenceAllowed(this.options.inferencePolicy, {
        projectId,
        modelProfileId: modelProfileId!,
        operation: "workflow_prompt",
      });
    }
    const modelProfile = modelProfileId
      ? this.repository.executionModelProfile(modelProfileId)
      : null;
    const maxSteps = requirePositiveLimit(
      limits.maxSteps,
      DEFAULT_WORKFLOW_MAX_STEPS,
      HARD_WORKFLOW_MAX_STEPS,
      "maxSteps",
    );
    const maxModelCalls = requirePositiveLimit(
      limits.maxModelCalls,
      DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
      HARD_WORKFLOW_MAX_MODEL_CALLS,
      "maxModelCalls",
    );
    if (
      executionSteps.length > maxSteps ||
      modelCalls > maxModelCalls
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow exceeds the configured execution limits.",
      );
    }
    const inputBinding = request.inputBinding ?? {};
    assertSnapshotTextIsSafe(inputBinding);
    const now = this.now();
    const runId = this.idFactory();
    const jobId = this.idFactory();
    const snapshotCore = {
      schemaVersion: 1,
      workflowId: workflow.id,
      workflowVersion: workflow.updatedAt,
      projectId,
      modelProfileId,
      config: {
        type: workflow.type,
        title: workflow.title,
        description: workflow.description,
        language: workflow.language,
        practice: workflow.practice,
        jurisdictions: workflow.jurisdictions,
        metadata: workflow.metadata,
        modelProfile,
        materializedSkillStep:
          workflow.type === "assistant" && workflow.steps.length === 0,
        execution: { maxSteps, maxModelCalls },
      },
      steps: executionSteps,
      skillMarkdown: snapshotSkillMarkdown(workflow),
      columns: workflow.type === "tabular" ? workflow.columns : [],
      inputBinding,
    } satisfies Omit<
      NewWorkflowExecutionSnapshot,
      "id" | "workflowRunId" | "snapshotSha256" | "createdAt"
    >;
    const snapshotValue = SafeStructuredValueSchema.parse(snapshotCore);
    assertSnapshotTextIsSafe(snapshotValue);
    const snapshotSha256 = sha256(snapshotValue);
    // The idempotency identity is execution lineage as well as input.  A
    // normal run is explicitly rooted (`retryOfRunId: null`) so it cannot
    // collide with a retry that happens to have identical user input.
    const inputSha256 = sha256({ inputBinding, retryOfRunId: null });
    const snapshot: NewWorkflowExecutionSnapshot = {
      id: this.idFactory(),
      workflowRunId: runId,
      snapshotSha256,
      createdAt: now,
      ...snapshotCore,
    };
    const record: NewWorkflowRunRecord = {
      id: runId,
      workflowId: workflow.id,
      projectId,
      modelProfileId,
      jobId,
      retryOfRunId: null,
      input: SafeStructuredValueSchema.parse({
        schemaVersion: 1,
        execution: { maxSteps, maxModelCalls, snapshotSha256 },
        inputBinding,
        retryOfRunId: null,
      }),
      steps: executionSteps.map((step, ordinal) => ({
        id: this.idFactory(),
        ordinal,
        attempt: 1,
        step,
        status: "queued",
        input: {},
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
      })),
      now,
    };
    const payload = SafeStructuredValueSchema.parse({
      runId,
      workflowId: workflow.id,
      snapshotId: snapshot.id,
      snapshotSha256,
      retryOfRunId: null,
    });
    return this.repository.createPreparedRun(
      {
        record,
        snapshot,
        idempotencyKey: request.idempotencyKey,
        inputSha256,
      },
      () =>
        this.jobs.enqueueInCurrentTransaction({
          id: jobId,
          type: "workflow_run",
          resourceType: "workflow_run",
          resourceId: runId,
          // The v6 workflow_run_idempotency row owns execution identity.  The
          // shared JobEnqueuer adapts this through the one Jobs state-machine
          // path, whose workflow_run job key remains intentionally null.
          idempotencyKey: request.idempotencyKey,
          payload,
          maxAttempts: MAX_WORKFLOW_STEP_ATTEMPTS,
          now,
        }),
    );
  }

  /** Retry from the parent's immutable snapshot, never from an edited workflow. */
  retryPreparedRun(runId: string, idempotencyKey: string): PreparedWorkflowRun {
    if (!idempotencyKey.trim() || idempotencyKey.length > 240) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Workflow retry idempotency key is invalid.",
      );
    }
    const parent = this.repository.requireRunDetail(runId);
    if (parent.run.status !== "failed") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Only failed workflow runs can be retried.",
      );
    }
    const failed = [...parent.steps]
      .reverse()
      .find((step) => step.status === "failed" && step.error?.retryable);
    if (!failed) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "The workflow run has no retryable failed step.",
      );
    }
    if (failed.attempt >= MAX_WORKFLOW_STEP_ATTEMPTS) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow step retry limit reached.",
      );
    }
    const parentSnapshot = this.repository.requireExecutionSnapshot(
      parent.run.id,
    );
    const requiresModel = modelCallCount(parentSnapshot.steps) > 0;
    if (requiresModel) {
      this.repository.requireExecutionModelProfileSnapshot(parentSnapshot);
    }
    const { maxSteps, maxModelCalls } = snapshotExecutionLimits(parentSnapshot);
    if (parentSnapshot.steps.length > maxSteps) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow snapshot exceeds its recorded execution limit.",
      );
    }
    if (
      parentSnapshot.steps.some((step) => step.kind === "tabular_column") ||
      parentSnapshot.steps.some(
        (step) =>
          step.kind === "prompt" &&
          step.modelProfileId !== undefined &&
          step.modelProfileId !== parentSnapshot.modelProfileId,
      ) ||
      modelCallCount(parentSnapshot.steps) > maxModelCalls
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow snapshot is not eligible for Assistant retry execution.",
      );
    }
    if (requiresModel && !parentSnapshot.modelProfileId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Retry model profile is unavailable.",
      );
    }
    if (parentSnapshot.modelProfileId) {
      this.repository.requireEnabledModelProfile(parentSnapshot.modelProfileId);
    }
    const now = this.now();
    const nextRunId = this.idFactory();
    const nextJobId = this.idFactory();
    const nextSnapshot: NewWorkflowExecutionSnapshot = {
      ...parentSnapshot,
      id: this.idFactory(),
      workflowRunId: nextRunId,
      createdAt: now,
    };
    const record: NewWorkflowRunRecord = {
      id: nextRunId,
      workflowId: parentSnapshot.workflowId,
      projectId: parentSnapshot.projectId,
      modelProfileId: parentSnapshot.modelProfileId,
      jobId: nextJobId,
      retryOfRunId: parent.run.id,
      input: SafeStructuredValueSchema.parse({
        schemaVersion: 1,
        execution: {
          maxSteps,
          maxModelCalls,
          snapshotSha256: parentSnapshot.snapshotSha256,
        },
        inputBinding: parentSnapshot.inputBinding,
        retryOfRunId: parent.run.id,
      }),
      steps: parent.steps.map((step) => ({
        id: this.idFactory(),
        ordinal: step.ordinal,
        attempt:
          step.ordinal === failed.ordinal ? step.attempt + 1 : step.attempt,
        step: step.step,
        status: step.ordinal < failed.ordinal ? "skipped" : "queued",
        input: step.ordinal < failed.ordinal ? step.input : {},
        output: step.ordinal < failed.ordinal ? step.output : null,
        error: null,
        startedAt: null,
        completedAt: step.ordinal < failed.ordinal ? now : null,
      })),
      now,
    };
    const payload = SafeStructuredValueSchema.parse({
      runId: nextRunId,
      workflowId: parentSnapshot.workflowId,
      snapshotId: nextSnapshot.id,
      snapshotSha256: parentSnapshot.snapshotSha256,
      retryOfRunId: parent.run.id,
    });
    return this.repository.createPreparedRun(
      {
        record,
        snapshot: nextSnapshot,
        idempotencyKey: idempotencyKey.trim(),
        inputSha256: sha256({
          inputBinding: parentSnapshot.inputBinding,
          retryOfRunId: parent.run.id,
        }),
      },
      () =>
        this.jobs.enqueueInCurrentTransaction({
          id: nextJobId,
          type: "workflow_run",
          resourceType: "workflow_run",
          resourceId: nextRunId,
          idempotencyKey: idempotencyKey.trim(),
          payload,
          maxAttempts: MAX_WORKFLOW_STEP_ATTEMPTS,
          now,
        }),
    );
  }

  startStep(runId: string, ordinal: number, input: unknown = {}) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const now = this.now();
    return this.repository.startStep(
      runId,
      ordinal,
      sanitizeJson(input),
      now,
      () => {
        const job = this.jobs.get(detail.run.jobId!);
        if (!job)
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Workflow job not found.",
          );
        const runningJob =
          job.status === "queued"
            ? this.jobs.transitionInCurrentTransaction(detail.run.jobId!, {
                type: "start",
                at: now,
              })
            : job;
        if (runningJob.status !== "running") {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Workflow job did not enter running state.",
          );
        }
        return runningJob;
      },
    );
  }

  startClaimedStep(
    runId: string,
    ordinal: number,
    input: unknown,
    claim: Pick<WorkflowClaimCallbacks, "assert">,
  ) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const now = this.now();
    return this.repository.startStep(
      runId,
      ordinal,
      sanitizeJson(input),
      now,
      () => {
        const job = claim.assert();
        if (job.id !== detail.run.jobId) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Workflow claim does not belong to this run.",
          );
        }
        return job;
      },
    );
  }

  completeStep(runId: string, ordinal: number, output: unknown) {
    return this.repository.completeStep(
      runId,
      ordinal,
      sanitizeJson(output),
      this.now(),
    );
  }

  completeClaimedStep(
    runId: string,
    ordinal: number,
    output: unknown,
    claim: Pick<WorkflowClaimCallbacks, "assert">,
  ) {
    return this.repository.completeStep(
      runId,
      ordinal,
      sanitizeJson(output),
      this.now(),
      () => {
        claim.assert();
      },
    );
  }

  failStep(runId: string, ordinal: number, error: unknown) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const safeError = sanitizeError(error);
    const now = this.now();
    return this.repository.failStep(runId, ordinal, safeError, now, () =>
      this.jobs.transitionInCurrentTransaction(detail.run.jobId!, {
        type: "fail",
        at: now,
        error: safeError,
      }),
    );
  }

  retryFailedStep(
    runId: string,
    ordinal: number,
    idempotencyKey?: string,
  ): PreparedWorkflowRun {
    if (!idempotencyKey?.trim()) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Workflow retries require an idempotency key.",
      );
    }
    const parent = this.repository.requireRunDetail(runId);
    const failed = parent.steps.find((step) => step.ordinal === ordinal);
    if (!failed || failed.status !== "failed" || !failed.error?.retryable) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "The selected workflow step is not retryable.",
      );
    }
    const latestRetryable = [...parent.steps]
      .reverse()
      .find((step) => step.status === "failed" && step.error?.retryable);
    if (!latestRetryable || latestRetryable.ordinal !== ordinal) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Only the latest retryable failed workflow step can be retried.",
      );
    }
    return this.retryPreparedRun(runId, idempotencyKey);
  }

  cancelRun(runId: string) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const job = this.jobs.get(detail.run.jobId);
    if (!job)
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow job not found.",
      );
    if (job.status !== "queued" && job.status !== "running") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow job is already terminal.",
      );
    }
    const now = this.now();
    const cancelled = this.repository.cancelRun(runId, now, () =>
      this.jobs.transitionInCurrentTransaction(job.id, {
        type: "cancel",
        at: now,
        reason: "Workflow run cancelled by user.",
      }),
    );
    // The workflow and Jobs terminal states are committed together above;
    // only then interrupt the in-flight provider request through the shared
    // Jobs AbortRegistry. Queued jobs simply have no registered controller.
    this.jobs.abortActive?.(job.id);
    return cancelled;
  }

  completeRun(runId: string, output: unknown) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const safeOutput = sanitizeJson(output);
    const now = this.now();
    return this.repository.completeRun(runId, safeOutput, now, () =>
      this.jobs.transitionInCurrentTransaction(detail.run.jobId!, {
        type: "complete",
        at: now,
        result: safeOutput,
      }),
    );
  }

  completeClaimedRun(
    runId: string,
    output: unknown,
    claim: Pick<WorkflowClaimCallbacks, "finishComplete">,
  ) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const safeOutput = sanitizeJson(output);
    return this.repository.completeRun(runId, safeOutput, this.now(), () => {
      const job = claim.finishComplete(safeOutput);
      if (job.id !== detail.run.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow claim does not belong to this run.",
        );
      }
      return job;
    });
  }

  failRun(runId: string, error: unknown) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const job = this.jobs.get(detail.run.jobId);
    if (!job) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow job not found.",
      );
    }
    const safeError = sanitizeError(error);
    const now = this.now();
    return this.repository.failRun(runId, safeError, now, () => {
      const runningJob =
        job.status === "queued"
          ? this.jobs.transitionInCurrentTransaction(job.id, {
              type: "start",
              at: now,
            })
          : job;
      if (runningJob.status !== "running") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow job cannot transition to failed.",
        );
      }
      return this.jobs.transitionInCurrentTransaction(job.id, {
        type: "fail",
        at: now,
        error: safeError,
      });
    });
  }

  failClaimedRun(
    runId: string,
    error: unknown,
    claim: Pick<WorkflowClaimCallbacks, "finishFailure">,
  ) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const safeError = sanitizeError(error);
    return this.repository.failRun(runId, safeError, this.now(), () => {
      const job = claim.finishFailure(safeError);
      if (job.id !== detail.run.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow claim does not belong to this run.",
        );
      }
      return job;
    });
  }
}
