import { createHash } from "node:crypto";
import { z } from "zod";

import { MIKE_LOCAL_USER_ID } from "./mikeCompatibility";
import { WorkspaceApiError } from "./errors";
import { SYSTEM_WORKFLOWS } from "./mikeSystemWorkflows.e32daad";
import type {
  Workflow,
  WorkflowColumn,
  WorkflowStep,
  WorkspaceJson,
} from "./types";
import type {
  MikeBuiltinWorkflowSeed,
  WorkflowsService,
} from "./services/workflows";
import type { PageRequest } from "./pagination";
import type {
  PreparedWorkflowRun,
  WorkflowRunDetail,
} from "./repositories/workflows";

const MikeWorkflowTypeSchema = z.enum(["assistant", "tabular"]);
const MikeColumnFormatSchema = z.enum([
  "text",
  "bulleted_list",
  "number",
  "currency",
  "yes_no",
  "date",
  "tag",
  "percentage",
  "monetary_amount",
]);
type MikeColumnFormat = z.infer<typeof MikeColumnFormatSchema>;

const MIKE_TABULAR_SKILL_METADATA_KEY = "mikeTabularSkillMarkdown";
const MIKE_TABULAR_FORMATS_METADATA_KEY = "mikeTabularColumnFormats";
const MIKE_TABULAR_TAGS_METADATA_KEY = "mikeTabularColumnTags";

const MikeWorkflowContributorSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    organisation: z.string().trim().min(1).max(160).nullable(),
    role: z.string().trim().min(1).max(160).nullable(),
    linkedin: z.string().trim().url().max(2_000).nullable(),
  })
  .strict();

export const MikeWorkflowColumnSchema = z
  .object({
    index: z.number().int().min(0).max(99),
    name: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    format: MikeColumnFormatSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  })
  .strict();
type MikeWorkflowColumn = z.infer<typeof MikeWorkflowColumnSchema>;

const MikeWorkflowMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000).nullable(),
    type: MikeWorkflowTypeSchema,
    contributors: z.array(MikeWorkflowContributorSchema).max(25),
    language: z.string().trim().min(1).max(160),
    version: z.string().trim().min(1).max(160).nullable(),
    practice: z.string().trim().min(1).max(160).nullable(),
    jurisdictions: z
      .array(z.string().trim().min(1).max(160))
      .max(100)
      .nullable(),
  })
  .strict();

export const MikeWorkflowWireSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    user_id: z.string().uuid().nullable(),
    metadata: MikeWorkflowMetadataSchema,
    skill_md: z.string().max(100_000).nullable(),
    columns_config: z.array(MikeWorkflowColumnSchema).max(100).nullable(),
    is_system: z.boolean(),
    // Mike's pinned system template emitter deliberately uses an empty
    // created_at sentinel, while durable local workflows use ISO timestamps.
    created_at: z.union([z.string().datetime(), z.literal("")]),
    shared_by_name: z.string().trim().min(1).max(160).nullable().optional(),
    allow_edit: z.boolean().optional(),
    is_owner: z.boolean().optional(),
    open_source_submission: z.null(),
  })
  .strict();

export type MikeWorkflowWire = z.infer<typeof MikeWorkflowWireSchema>;

export const MikeCreateWorkflowRequestSchema = z
  .object({
    metadata: z
      .object({
        title: z.string().trim().min(1).max(200),
        type: MikeWorkflowTypeSchema,
        language: z.string().trim().min(1).max(160).nullable().optional(),
        practice: z.string().trim().min(1).max(160).nullable().optional(),
        jurisdictions: z
          .array(z.string().trim().min(1).max(160))
          .max(100)
          .nullable()
          .optional(),
      })
      .strict(),
    skill_md: z.string().max(100_000).optional(),
    columns_config: z.array(MikeWorkflowColumnSchema).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.metadata.type === "assistant" &&
      value.columns_config !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns_config"],
        message: "Assistant workflows do not accept columns_config.",
      });
    }
  });

export const MikeUpdateWorkflowRequestSchema = z
  .object({
    metadata: z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        language: z.string().trim().min(1).max(160).nullable().optional(),
        practice: z.string().trim().min(1).max(160).nullable().optional(),
        jurisdictions: z
          .array(z.string().trim().min(1).max(160))
          .max(100)
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    skill_md: z.string().max(100_000).optional(),
    columns_config: z.array(MikeWorkflowColumnSchema).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "An update is required.");

export type MikeCreateWorkflowRequest = z.infer<
  typeof MikeCreateWorkflowRequestSchema
>;
export type MikeUpdateWorkflowRequest = z.infer<
  typeof MikeUpdateWorkflowRequestSchema
>;

const VeraWorkflowDefinitionPromptStepSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal("prompt"),
    name: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    model_profile_id: z.string().uuid().optional(),
    // Reserved for a future real binding implementation. An empty mapping is
    // accepted so clients can emit their default form shape; any key fails.
    input_mapping: z.object({}).strict().optional(),
  })
  .strict();

const VeraWorkflowDefinitionRetrievalStepSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal("document_retrieval"),
    name: z.string().trim().min(1).max(160),
    query_template: z.string().trim().min(1).max(2_000),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

const VeraWorkflowDefinitionOutputStepSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal("output"),
    name: z.string().trim().min(1).max(160),
    format: z.enum(["text", "json"]),
  })
  .strict();

export const VeraWorkflowDefinitionStepSchema = z.discriminatedUnion("type", [
  VeraWorkflowDefinitionPromptStepSchema,
  VeraWorkflowDefinitionRetrievalStepSchema,
  VeraWorkflowDefinitionOutputStepSchema,
]);

const VeraWorkflowDefinitionFieldsObjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000).nullable(),
    project_id: z.string().uuid().nullable(),
    steps: z.array(VeraWorkflowDefinitionStepSchema).max(100),
  })
  .strict();

function refineVeraWorkflowDefinition(
  value: z.infer<typeof VeraWorkflowDefinitionFieldsObjectSchema>,
  context: z.RefinementCtx,
) {
  const ids = new Set<string>();
  for (const [index, step] of value.steps.entries()) {
    if (ids.has(step.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", index, "id"],
        message: "Workflow step identifiers must be unique.",
      });
    }
    ids.add(step.id);
  }
  const outputIndexes = value.steps
    .map((step, index) => (step.type === "output" ? index : -1))
    .filter((index) => index >= 0);
  if (outputIndexes.length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps"],
      message: "A workflow can contain at most one output step.",
    });
  }
  const outputIndex = outputIndexes[0];
  if (outputIndex !== undefined && outputIndex !== value.steps.length - 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", outputIndex],
      message: "The output step must be the final workflow step.",
    });
  }
  if (
    outputIndex !== undefined &&
    !value.steps.slice(0, outputIndex).some((step) => step.type === "prompt")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", outputIndex],
      message: "The output step requires an earlier prompt step.",
    });
  }
}

export const VeraWorkflowDefinitionUpdateRequestSchema =
  VeraWorkflowDefinitionFieldsObjectSchema.superRefine(
    refineVeraWorkflowDefinition,
  );

export const VeraWorkflowDefinitionWireSchema =
  VeraWorkflowDefinitionFieldsObjectSchema.extend({
    id: z.string().uuid(),
    type: z.literal("assistant"),
    updated_at: z.string().datetime(),
  })
    .strict()
    .superRefine(refineVeraWorkflowDefinition);

export type VeraWorkflowDefinitionWire = z.infer<
  typeof VeraWorkflowDefinitionWireSchema
>;

function outputTypeToFormat(column: WorkflowColumn): MikeColumnFormat {
  switch (column.outputType) {
    case "boolean":
      return "yes_no";
    case "enum":
      return "tag";
    case "number":
      return "number";
    case "text":
      return "text";
  }
}

function formatToOutputType(format: MikeColumnFormat | undefined) {
  if (format === "yes_no") return "boolean" as const;
  if (format === "tag") return "enum" as const;
  if (
    format === "number" ||
    format === "currency" ||
    format === "percentage" ||
    format === "monetary_amount"
  ) {
    return "number" as const;
  }
  return "text" as const;
}

function defaultFormatForOutputType(
  outputType: ReturnType<typeof formatToOutputType>,
): MikeColumnFormat {
  switch (outputType) {
    case "boolean":
      return "yes_no";
    case "enum":
      return "tag";
    case "number":
      return "number";
    case "text":
      return "text";
  }
}

function stableColumnKey(name: string, index: number) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = normalized.replace(/^[^a-z]+/, "").slice(0, 48);
  return `${base || "column"}_${index}`.slice(0, 63);
}

function asMetadataRecord(
  value: WorkspaceJson | undefined,
): Record<string, WorkspaceJson> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function mikeColumnFormat(
  workflow: Workflow,
  column: WorkflowColumn,
): MikeColumnFormat {
  const formats = asMetadataRecord(
    workflow.metadata[MIKE_TABULAR_FORMATS_METADATA_KEY],
  );
  const format = formats?.[column.key];
  return MikeColumnFormatSchema.safeParse(format).success
    ? MikeColumnFormatSchema.parse(format)
    : outputTypeToFormat(column);
}

function mikeColumnTags(workflow: Workflow, column: WorkflowColumn): string[] {
  const tags = asMetadataRecord(
    workflow.metadata[MIKE_TABULAR_TAGS_METADATA_KEY],
  )?.[column.key];
  const parsed = z
    .array(z.string().trim().min(1).max(160))
    .max(100)
    .safeParse(tags);
  if (parsed.success) return parsed.data;
  return column.enumValues ?? [];
}

function mikeTabularSkillMarkdown(workflow: Workflow): string {
  const value = workflow.metadata[MIKE_TABULAR_SKILL_METADATA_KEY];
  return typeof value === "string" ? value : "";
}

function mikeMetadataString(workflow: Workflow, key: string): string | null {
  const value = workflow.metadata[key];
  return typeof value === "string" ? value : null;
}

function mikeWorkflowContributors(workflow: Workflow) {
  const parsed = z
    .array(MikeWorkflowContributorSchema)
    .max(25)
    .safeParse(workflow.metadata.mikeContributors);
  return parsed.success
    ? parsed.data
    : workflow.isBuiltin
      ? [
          {
            name: "Mike",
            organisation: null,
            role: null,
            linkedin: null,
          },
        ]
      : [];
}

function parseMikeColumns(columns: readonly MikeWorkflowColumn[]): {
  columns: Array<{
    key: string;
    title: string;
    outputType: "boolean" | "enum" | "number" | "text";
    prompt: string;
    enumValues?: string[];
  }>;
  formats: Record<string, MikeColumnFormat>;
  tags: Record<string, string[]>;
} {
  const formats: Record<string, MikeColumnFormat> = {};
  const tags: Record<string, string[]> = {};
  const parsedColumns = columns.map((column) => {
    const key = stableColumnKey(column.name, column.index);
    const outputType = formatToOutputType(column.format);
    if (outputType === "enum" && !column.tags?.length) {
      throw new WorkspaceApiError(
        422,
        "VALIDATION_ERROR",
        "Tag workflow columns require non-empty tags.",
      );
    }
    formats[key] = column.format ?? defaultFormatForOutputType(outputType);
    if (column.tags?.length) tags[key] = [...column.tags];
    return {
      key,
      title: column.name,
      outputType,
      prompt: column.prompt,
      enumValues: outputType === "enum" ? column.tags : undefined,
    };
  });
  return { columns: parsedColumns, formats, tags };
}

function mikeTabularMetadata(
  skillMarkdown: string,
  formats: Record<string, MikeColumnFormat>,
  tags: Record<string, string[]>,
): Record<string, WorkspaceJson> {
  return {
    [MIKE_TABULAR_SKILL_METADATA_KEY]: skillMarkdown,
    [MIKE_TABULAR_FORMATS_METADATA_KEY]: formats,
    [MIKE_TABULAR_TAGS_METADATA_KEY]: tags,
  };
}

function assertNoSecretOrPath(value: unknown): void {
  const blockedKey =
    /(secret|password|credential|api[_-]?key|authorization|cookie|token|storage[_-]?path|absolute[_-]?path)/i;
  const blockedValue =
    /(?:^|\s)(?:bearer\s+|sk-[a-z0-9_-]{8,}|file:\/\/|\/[Uu]sers\/|\/home\/|[A-Za-z]:\\)/i;
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (blockedValue.test(entry)) {
        throw new WorkspaceApiError(
          422,
          "VALIDATION_ERROR",
          "Workflow payload contains a forbidden secret or local path.",
        );
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (blockedKey.test(key)) {
          throw new WorkspaceApiError(
            422,
            "VALIDATION_ERROR",
            "Workflow payload contains a forbidden field.",
          );
        }
        visit(child);
      }
    }
  };
  visit(value);
}

function definitionStepToCanonical(
  step: z.infer<typeof VeraWorkflowDefinitionStepSchema>,
): WorkflowStep {
  if (step.type === "prompt") {
    return {
      id: step.id,
      kind: "prompt",
      title: step.name,
      prompt: step.prompt,
      ...(step.model_profile_id === undefined
        ? {}
        : { modelProfileId: step.model_profile_id }),
    };
  }
  if (step.type === "document_retrieval") {
    return {
      id: step.id,
      kind: "document_context",
      title: step.name,
      queryTemplate: step.query_template,
      resultLimit: step.limit,
      maxDocuments: Math.min(step.limit, 20),
      maxChunksPerDocument: Math.min(step.limit, 20),
    };
  }
  return {
    id: step.id,
    kind: "output",
    title: step.name,
    format: step.format,
  };
}

function definitionStepWire(step: WorkflowStep) {
  if (!step.id) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Client workflow definition step identifier is unavailable.",
    );
  }
  if (step.kind === "prompt") {
    return VeraWorkflowDefinitionStepSchema.parse({
      id: step.id,
      type: "prompt",
      name: step.title,
      prompt: step.prompt,
      ...(step.modelProfileId === undefined
        ? {}
        : { model_profile_id: step.modelProfileId }),
    });
  }
  if (step.kind === "document_context") {
    return VeraWorkflowDefinitionStepSchema.parse({
      id: step.id,
      type: "document_retrieval",
      name: step.title,
      query_template: step.queryTemplate ?? step.title,
      limit:
        step.resultLimit ??
        Math.min(step.maxDocuments * step.maxChunksPerDocument, 100),
    });
  }
  if (step.kind === "output") {
    return VeraWorkflowDefinitionStepSchema.parse({
      id: step.id,
      type: "output",
      name: step.title,
      format: step.format,
    });
  }
  throw new WorkspaceApiError(
    409,
    "CONFLICT",
    "Tabular column steps are not valid in an Assistant definition.",
  );
}

export function parseVeraWorkflowDefinitionUpdate(value: unknown) {
  assertNoSecretOrPath(value);
  const input = VeraWorkflowDefinitionUpdateRequestSchema.parse(value);
  return {
    projectId: input.project_id,
    title: input.name,
    description: input.description,
    steps: input.steps.map(definitionStepToCanonical),
  };
}

export function serializeVeraWorkflowDefinition(
  workflow: Workflow,
): VeraWorkflowDefinitionWire {
  if (workflow.type !== "assistant" || workflow.isBuiltin) {
    throw new WorkspaceApiError(
      403,
      "FORBIDDEN",
      "Only local Assistant workflows expose editable definitions.",
    );
  }
  return VeraWorkflowDefinitionWireSchema.parse({
    id: workflow.id,
    type: "assistant",
    name: workflow.title,
    description: workflow.description,
    project_id: workflow.projectId,
    steps: workflow.steps.map(definitionStepWire),
    updated_at: workflow.updatedAt,
  });
}

export function parseMikeWorkflowCreate(value: unknown) {
  assertNoSecretOrPath(value);
  const input = MikeCreateWorkflowRequestSchema.parse(value);
  const metadata = input.metadata;
  if (metadata.type === "assistant") {
    return {
      type: "assistant" as const,
      title: metadata.title,
      skillMarkdown: input.skill_md ?? "",
      steps: [],
      language: metadata.language ?? "English",
      practice: metadata.practice ?? "General Transactions",
      jurisdictions: metadata.jurisdictions ?? ["General"],
      metadata: {},
    };
  }
  const parsedColumns = parseMikeColumns(input.columns_config ?? []);
  return {
    type: "tabular" as const,
    title: metadata.title,
    columns: parsedColumns.columns,
    steps: [],
    language: metadata.language ?? "English",
    practice: metadata.practice ?? "General Transactions",
    jurisdictions: metadata.jurisdictions ?? ["General"],
    metadata: mikeTabularMetadata(
      input.skill_md ?? "",
      parsedColumns.formats,
      parsedColumns.tags,
    ),
  };
}

export function parseMikeWorkflowUpdate(value: unknown) {
  assertNoSecretOrPath(value);
  const input = MikeUpdateWorkflowRequestSchema.parse(value);
  const metadata = input.metadata;
  return {
    ...(metadata?.title === undefined ? {} : { title: metadata.title }),
    ...(metadata?.language === undefined
      ? {}
      : { language: metadata.language ?? "English" }),
    ...(metadata?.practice === undefined
      ? {}
      : { practice: metadata.practice ?? "General Transactions" }),
    ...(metadata?.jurisdictions === undefined
      ? {}
      : { jurisdictions: metadata.jurisdictions ?? ["General"] }),
    // Type is intentionally resolved by WorkflowsService.update.  At this
    // boundary a `skill_md` may belong to either an assistant workflow or a
    // Mike tabular workflow, whose domain model stores it in compatibility
    // metadata rather than an assistant-only property.
    ...(input.skill_md === undefined
      ? {}
      : { mikeSkillMarkdown: input.skill_md }),
    ...(input.columns_config === undefined
      ? {}
      : (() => {
          const columns = parseMikeColumns(input.columns_config);
          return {
            columns: columns.columns,
            mikeTabularColumnFormats: columns.formats,
            mikeTabularColumnTags: columns.tags,
          };
        })()),
  };
}

export function serializeMikeWorkflow(
  workflow: Workflow,
  options: { upstreamId?: string | null; upstreamVersion?: string | null } = {},
): MikeWorkflowWire {
  const isSystem = workflow.isBuiltin;
  const id = options.upstreamId ?? workflow.id;
  const wire: MikeWorkflowWire = {
    id,
    user_id: isSystem ? null : MIKE_LOCAL_USER_ID,
    metadata: {
      title: workflow.title,
      description:
        mikeMetadataString(workflow, "mikeDescription") ?? workflow.description,
      type: workflow.type,
      contributors: mikeWorkflowContributors(workflow),
      language: workflow.language,
      version: options.upstreamVersion ?? workflow.updatedAt,
      practice: workflow.practice,
      jurisdictions: workflow.jurisdictions,
    },
    skill_md:
      workflow.type === "assistant"
        ? workflow.skillMarkdown || null
        : mikeTabularSkillMarkdown(workflow) || null,
    columns_config:
      workflow.type === "tabular"
        ? workflow.columns.map((column) => ({
            index: column.ordinal,
            name: column.title,
            prompt: column.prompt,
            format: mikeColumnFormat(workflow, column),
            ...(mikeColumnTags(workflow, column).length
              ? { tags: mikeColumnTags(workflow, column) }
              : {}),
          }))
        : null,
    is_system: isSystem,
    created_at: isSystem ? "" : workflow.createdAt,
    shared_by_name: null,
    allow_edit: !isSystem,
    is_owner: !isSystem,
    open_source_submission: null,
  };
  return MikeWorkflowWireSchema.parse(wire);
}

export function assertMikeWorkflowPayloadSafe(value: unknown) {
  assertNoSecretOrPath(value);
}

export const MIKE_SYSTEM_WORKFLOWS_UPSTREAM_COMMIT =
  "e32daad5a4c64a5561e04c53ee12411e3c5e7238" as const;
export const MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256 =
  "e800f8e1ba518d821c07d07355a13b511ed3d8334897e59db02685df378d2b03" as const;
const MIKE_SYSTEM_WORKFLOWS_ASSET_SHA256 =
  "b96abfd98360d78c3d47a352cfacb0ca20e135fee9f4e0267b526ec949097ff5" as const;

function canonicalAssetSha256() {
  return createHash("sha256")
    .update(JSON.stringify(SYSTEM_WORKFLOWS))
    .digest("hex");
}

/**
 * Pure, offline loader for the exact system-workflow asset copied from the
 * fixed Mike source file. The runtime never fetches upstream; a data drift is
 * rejected before it can seed a different built-in template set.
 */
export function loadPinnedMikeSystemWorkflowSeeds(): readonly MikeBuiltinWorkflowSeed[] {
  if (canonicalAssetSha256() !== MIKE_SYSTEM_WORKFLOWS_ASSET_SHA256) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Pinned Mike system workflow asset checksum does not match the fixed source.",
    );
  }
  return SYSTEM_WORKFLOWS.map((source) => {
    const wire = MikeWorkflowWireSchema.parse({
      ...source,
      open_source_submission: null,
    });
    const parsed = parseMikeWorkflowCreate({
      metadata: {
        title: wire.metadata.title,
        type: wire.metadata.type,
        language: wire.metadata.language,
        practice: wire.metadata.practice,
        jurisdictions: wire.metadata.jurisdictions,
      },
      skill_md: wire.skill_md ?? "",
      ...(wire.metadata.type === "tabular"
        ? { columns_config: wire.columns_config ?? [] }
        : {}),
    });
    const metadata: Record<string, WorkspaceJson> = {
      ...parsed.metadata,
      mikeDescription: wire.metadata.description,
      mikeContributors: wire.metadata.contributors,
      mikeSourceCommit: MIKE_SYSTEM_WORKFLOWS_UPSTREAM_COMMIT,
      mikeSourceSha256: MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256,
      mikeSourceCreatedAt: wire.created_at,
    };
    const workflow =
      parsed.type === "assistant"
        ? {
            type: "assistant" as const,
            projectId: null,
            title: parsed.title,
            description: wire.metadata.description,
            skillMarkdown: parsed.skillMarkdown,
            steps: parsed.steps,
            columns: [],
            language: parsed.language,
            practice: parsed.practice,
            jurisdictions: parsed.jurisdictions,
            metadata,
          }
        : {
            type: "tabular" as const,
            projectId: null,
            title: parsed.title,
            description: wire.metadata.description,
            skillMarkdown: "",
            steps: parsed.steps,
            columns: parsed.columns,
            language: parsed.language,
            practice: parsed.practice,
            jurisdictions: parsed.jurisdictions,
            metadata,
          };
    return {
      upstreamId: wire.id,
      upstreamVersion: wire.metadata.version ?? "unversioned",
      sourceSha256: MIKE_SYSTEM_WORKFLOWS_SOURCE_SHA256,
      workflow,
    } satisfies MikeBuiltinWorkflowSeed;
  });
}

/** Idempotence is enforced by WorkflowsRepository's upstream_id mapping. */
export function seedPinnedMikeSystemWorkflows(workflows: WorkflowsService) {
  return loadPinnedMikeSystemWorkflowSeeds().map((seed) =>
    workflows.seedMikeBuiltin(seed),
  );
}

const MIKE_WORKFLOW_LIST_PAGE_SIZE = 25;
const MAX_MIKE_WORKFLOW_LIST_PAGES = 100;

/**
 * Service-only implementation of the Mike CRUD port.  It deliberately owns
 * no database handle: controller/router code stays transport-only while this
 * adapter walks the canonical cursor API until it has Mike's expected flat
 * Workflow[] response.
 */
export class MikeWorkflowCrudPortAdapter {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly options: {
      executionAvailable?: () => boolean;
    } = {},
  ) {}

  executionAvailable(_context: { principalId: string }) {
    return this.options.executionAvailable?.() === true;
  }

  private requireExecutionAvailable() {
    if (!this.options.executionAvailable?.()) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Workflow execution runtime is unavailable.",
      );
    }
  }

  private serialize(workflow: Workflow): MikeWorkflowWire {
    const mapping = this.workflows.getMikeBuiltinMapping(workflow.id);
    return serializeMikeWorkflow(workflow, {
      upstreamId: mapping?.upstreamId,
      upstreamVersion: mapping?.upstreamVersion,
    });
  }

  async list(
    _context: { principalId: string },
    input: { type?: "assistant" | "tabular" },
  ): Promise<readonly MikeWorkflowWire[]> {
    const values: MikeWorkflowWire[] = [];
    const seenWorkflowIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (
      let pageNumber = 0;
      pageNumber < MAX_MIKE_WORKFLOW_LIST_PAGES;
      pageNumber += 1
    ) {
      const page = this.workflows.list({
        type: input.type,
        // Mike's WorkflowList fetches /workflows and /workflows/hidden in
        // parallel so hidden builtin templates remain present and greyable.
        includeHidden: true,
        limit: MIKE_WORKFLOW_LIST_PAGE_SIZE,
        cursor,
      });
      for (const workflow of page.items) {
        if (seenWorkflowIds.has(workflow.id)) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Workflow cursor traversal returned a duplicate workflow.",
          );
        }
        seenWorkflowIds.add(workflow.id);
        values.push(this.serialize(workflow));
      }
      if (page.nextCursor === null) return values;
      if (seenCursors.has(page.nextCursor)) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workflow cursor traversal did not advance.",
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Workflow list exceeds the bounded Mike compatibility traversal.",
    );
  }

  async get(
    _context: { principalId: string },
    workflowId: string,
  ): Promise<MikeWorkflowWire> {
    return this.serialize(
      this.workflows.get(this.workflows.resolveMikeWorkflowId(workflowId)),
    );
  }

  async getDefinition(
    _context: { principalId: string },
    workflowId: string,
  ): Promise<VeraWorkflowDefinitionWire> {
    return serializeVeraWorkflowDefinition(
      this.workflows.getAssistantDefinition(
        this.workflows.resolveMikeWorkflowId(workflowId),
      ),
    );
  }

  async updateDefinition(
    _context: { principalId: string },
    workflowId: string,
    input: ReturnType<typeof parseVeraWorkflowDefinitionUpdate>,
  ): Promise<VeraWorkflowDefinitionWire> {
    return serializeVeraWorkflowDefinition(
      this.workflows.updateAssistantDefinition(
        this.workflows.resolveMikeWorkflowId(workflowId),
        input,
      ),
    );
  }

  async create(
    _context: { principalId: string },
    input: ReturnType<typeof parseMikeWorkflowCreate>,
  ): Promise<MikeWorkflowWire> {
    return this.serialize(this.workflows.create(input));
  }

  async update(
    _context: { principalId: string },
    workflowId: string,
    input: ReturnType<typeof parseMikeWorkflowUpdate>,
  ): Promise<MikeWorkflowWire> {
    return this.serialize(
      this.workflows.update(
        this.workflows.resolveMikeWorkflowId(workflowId),
        input,
      ),
    );
  }

  async delete(
    _context: { principalId: string },
    workflowId: string,
  ): Promise<void> {
    this.workflows.delete(this.workflows.resolveMikeWorkflowId(workflowId));
  }

  async listHidden(_context: {
    principalId: string;
  }): Promise<readonly string[]> {
    return this.workflows.listHiddenMikeWorkflowIds();
  }

  async hide(
    _context: { principalId: string },
    workflowId: string,
  ): Promise<void> {
    this.workflows.hideMikeWorkflow(workflowId);
  }

  async unhide(
    _context: { principalId: string },
    workflowId: string,
  ): Promise<void> {
    this.workflows.unhideMikeWorkflow(workflowId);
  }

  async startRun(
    _context: { principalId: string },
    workflowId: string,
    input: unknown,
  ): Promise<PreparedWorkflowRun> {
    this.requireExecutionAvailable();
    return this.workflows.prepareRun(
      this.workflows.resolveMikeWorkflowId(workflowId),
      input,
    );
  }

  async listRuns(
    _context: { principalId: string },
    workflowId: string,
    page: PageRequest,
  ) {
    this.requireExecutionAvailable();
    return this.workflows.listRuns(
      this.workflows.resolveMikeWorkflowId(workflowId),
      page,
    );
  }

  async getRun(
    _context: { principalId: string },
    runId: string,
  ): Promise<WorkflowRunDetail> {
    this.requireExecutionAvailable();
    return this.workflows.getRun(runId);
  }

  async cancelRun(
    _context: { principalId: string },
    runId: string,
  ): Promise<WorkflowRunDetail> {
    this.requireExecutionAvailable();
    return this.workflows.cancelRun(runId);
  }

  async retryRun(
    _context: { principalId: string },
    runId: string,
    idempotencyKey: string,
  ): Promise<PreparedWorkflowRun> {
    this.requireExecutionAvailable();
    return this.workflows.retryPreparedRun(runId, idempotencyKey);
  }
}
