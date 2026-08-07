import { z } from "zod";

export const MATTER_CONTEXT_KIND = "matter_context_v1" as const;
export const FIXED_MATTER_CONTEXT_CHECKPOINT_KEY =
  "fixed_matter_context" as const;

const boundedId = z.string().trim().min(1).max(200);

export const matterContextSourceSchema = z
  .object({
    document_id: boundedId,
    version_id: boundedId,
    filename: z.string().trim().min(1).max(500),
    file_type: z.string().trim().min(1).max(80).nullable(),
    role: z.enum(["source", "template", "precedent", "authority"]),
  })
  .strict();

export const workflowSnapshotSchema = z
  .object({
    id: boundedId,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(4000),
    type: z.enum(["assistant", "tabular"]),
    instructions: z.string().max(100_000),
    columns: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();

export const matterContextSchema = z
  .object({
    kind: z.literal(MATTER_CONTEXT_KIND),
    matter_id: boundedId,
    sources: z.array(matterContextSourceSchema).max(100),
    workflow: workflowSnapshotSchema.nullable(),
    compiled_at: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const documentIds = value.sources.map((source) => source.document_id);
    if (new Set(documentIds).size !== documentIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "Task context document ids must be unique",
      });
    }
  });

export type MatterContextSourceV1 = z.infer<typeof matterContextSourceSchema>;
export type MatterContextWorkflowV1 = z.infer<typeof workflowSnapshotSchema>;
export type MatterContextManifestV1 = z.infer<typeof matterContextSchema>;

/**
 * Packs may compile their own validated, versioned context beside this generic
 * Matter receipt. The Kernel treats that value as opaque and never imports a
 * Contract, Litigation, Patent, or Research schema.
 */
export type PackContextCompilerV1<TInput, TContext> = (input: {
  matter: MatterContextManifestV1;
  packInput: TInput;
}) => TContext | Promise<TContext>;

export type MatterDocumentRow = {
  id: string;
  project_id: string | null;
  current_version_id: string | null;
  status: string | null;
};

export type MatterVersionRow = {
  id: string;
  document_id: string;
  filename: string | null;
  file_type: string | null;
  storage_path: string | null;
  deleted_at: string | null;
};

export type MatterContextIssueCode =
  | "matter_context_malformed"
  | "matter_context_scope_mismatch"
  | "matter_context_source_unavailable"
  | "matter_context_source_version_changed"
  | "matter_context_version_invalid"
  | "matter_context_workflow_mismatch";

export class MatterContextInvalidError extends Error {
  constructor(
    readonly code: MatterContextIssueCode,
    message: string,
    readonly facts: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MatterContextInvalidError";
  }
}

export function validateMatterContextManifest(value: unknown) {
  return matterContextSchema.parse(value);
}

export function readFixedMatterContext(task: {
  latest_checkpoint?: unknown;
}): MatterContextManifestV1 | null {
  const checkpoint = task.latest_checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return null;
  }
  const row = checkpoint as Record<string, unknown>;
  const contract =
    row.contract &&
    typeof row.contract === "object" &&
    !Array.isArray(row.contract)
      ? (row.contract as Record<string, unknown>)
      : null;
  const staged = Object.hasOwn(row, FIXED_MATTER_CONTEXT_CHECKPOINT_KEY)
    ? row[FIXED_MATTER_CONTEXT_CHECKPOINT_KEY]
    : undefined;
  const contracted = contract?.context_manifest;
  if (staged === undefined && contracted === undefined) return null;
  try {
    const fixed = validateMatterContextManifest(staged ?? contracted);
    if (staged !== undefined && contracted !== undefined) {
      const assignment = validateMatterContextManifest(contracted);
      if (JSON.stringify(fixed) !== JSON.stringify(assignment)) {
        throw new Error("staged and Assignment Contract contexts differ");
      }
    }
    return fixed;
  } catch (error) {
    throw new MatterContextInvalidError(
      "matter_context_malformed",
      error instanceof Error
        ? `Fixed Matter context is malformed: ${error.message}`
        : "Fixed Matter context is malformed",
    );
  }
}

/**
 * Preserve server-owned assignment fields and durable execution receipts when
 * a mutable progress checkpoint is replaced. Transient retry/user-input fields
 * must not leak into the next checkpoint.
 */
export function mergeImmutableAgentTaskCheckpoint(
  previous: unknown,
  next: Record<string, unknown> | null,
) {
  const retained: Record<string, unknown> = {};
  if (previous && typeof previous === "object" && !Array.isArray(previous)) {
    const row = previous as Record<string, unknown>;
    for (const key of [
      FIXED_MATTER_CONTEXT_CHECKPOINT_KEY,
      "schema_version",
      "contract",
      "assignment_revisions",
      "resolved_required_input_ids",
      "step_receipts",
    ]) {
      if (Object.hasOwn(row, key)) retained[key] = row[key];
    }
  }
  if (!next && Object.keys(retained).length === 0) return null;
  return { ...retained, ...(next ?? {}) };
}

export function buildMatterContextManifest(input: {
  matterId: string;
  sources: MatterContextSourceV1[];
  workflow?: MatterContextWorkflowV1 | null;
  compiledAt?: string;
}) {
  return validateMatterContextManifest({
    kind: MATTER_CONTEXT_KIND,
    matter_id: input.matterId,
    sources: input.sources,
    workflow: input.workflow ?? null,
    compiled_at: input.compiledAt ?? new Date().toISOString(),
  });
}

export function assertMatterContextRowsMatchManifest(
  manifest: MatterContextManifestV1,
  documents: MatterDocumentRow[],
  versions: MatterVersionRow[],
) {
  const documentsById = new Map(documents.map((row) => [row.id, row]));
  const versionsById = new Map(versions.map((row) => [row.id, row]));
  for (const source of manifest.sources) {
    const document = documentsById.get(source.document_id);
    if (!document || document.project_id !== manifest.matter_id) {
      throw new MatterContextInvalidError(
        "matter_context_scope_mismatch",
        "A fixed source is no longer available in this Matter.",
        { document_id: source.document_id, matter_id: manifest.matter_id },
      );
    }
    if (document.status !== "ready") {
      throw new MatterContextInvalidError(
        "matter_context_source_unavailable",
        "A fixed source is not ready for use.",
        { document_id: source.document_id, status: document.status },
      );
    }
    if (document.current_version_id !== source.version_id) {
      throw new MatterContextInvalidError(
        "matter_context_source_version_changed",
        "A fixed source changed version after this task was created.",
        {
          document_id: source.document_id,
          fixed_version_id: source.version_id,
          current_version_id: document.current_version_id,
        },
      );
    }
    const version = versionsById.get(source.version_id);
    if (
      !version ||
      version.document_id !== source.document_id ||
      version.deleted_at ||
      !version.storage_path
    ) {
      throw new MatterContextInvalidError(
        "matter_context_version_invalid",
        "A fixed source version is missing, deleted, or belongs to another document.",
        { document_id: source.document_id, version_id: source.version_id },
      );
    }
  }
}
