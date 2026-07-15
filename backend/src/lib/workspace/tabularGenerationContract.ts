import { createHash } from "node:crypto";
import { z } from "zod";

import { WorkspaceIdSchema } from "./contracts";
import type { AuthoritativeExtractedTextSnapshot } from "./services/authoritativeExtractedText";
import type { TabularColumnRecord } from "./repositories/tabular";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const TabularCellJobPayloadSchema = z
  .object({
    schema: z.literal("vera-tabular-cell-job-v1"),
    reviewId: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    cellId: WorkspaceIdSchema,
    generationId: WorkspaceIdSchema,
    document: z
      .object({
        documentId: WorkspaceIdSchema,
        versionId: WorkspaceIdSchema,
        blobRecordId: WorkspaceIdSchema,
        sourceContentSha256: Sha256,
        textSha256: Sha256,
        textBytes: z.number().int().nonnegative(),
      })
      .strict(),
    column: z
      .object({
        columnId: WorkspaceIdSchema,
        revisionSha256: Sha256,
      })
      .strict(),
    model: z
      .object({
        profileId: WorkspaceIdSchema,
        executionRevision: z.number().int().nonnegative(),
      })
      .strict(),
    reviewRevisionSha256: Sha256,
    generation: z.number().int().positive().max(100),
  })
  .strict();

export type TabularCellJobPayload = z.infer<
  typeof TabularCellJobPayloadSchema
>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function tabularGenerationSha256(value: unknown) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function tabularColumnRevisionSha256(column: TabularColumnRecord) {
  return tabularGenerationSha256({
    id: column.id,
    key: column.key,
    title: column.title,
    outputType: column.outputType,
    format: column.format,
    prompt: column.prompt,
    enumValues: column.enumValues,
    tags: column.tags,
    ordinal: column.ordinal,
  });
}

export function tabularReviewRevisionSha256(input: {
  reviewId: string;
  projectId: string;
  workflowId: string | null;
  documentIds: readonly string[];
  columns: readonly TabularColumnRecord[];
}) {
  return tabularGenerationSha256({
    reviewId: input.reviewId,
    projectId: input.projectId,
    workflowId: input.workflowId,
    documentIds: input.documentIds,
    columns: input.columns.map((column) => ({
      id: column.id,
      revisionSha256: tabularColumnRevisionSha256(column),
    })),
  });
}

export function tabularCellJobPayload(input: {
  reviewId: string;
  projectId: string;
  cellId: string;
  generationId: string;
  snapshot: AuthoritativeExtractedTextSnapshot;
  column: TabularColumnRecord;
  modelProfileId: string;
  modelExecutionRevision: number;
  reviewRevisionSha256: string;
  generation: number;
}): TabularCellJobPayload {
  return TabularCellJobPayloadSchema.parse({
    schema: "vera-tabular-cell-job-v1",
    reviewId: input.reviewId,
    projectId: input.projectId,
    cellId: input.cellId,
    generationId: input.generationId,
    document: {
      documentId: input.snapshot.documentId,
      versionId: input.snapshot.versionId,
      blobRecordId: input.snapshot.blobRecordId,
      sourceContentSha256: input.snapshot.sourceContentSha256,
      textSha256: input.snapshot.textSha256,
      textBytes: input.snapshot.textBytes,
    },
    column: {
      columnId: input.column.id,
      revisionSha256: tabularColumnRevisionSha256(input.column),
    },
    model: {
      profileId: input.modelProfileId,
      executionRevision: input.modelExecutionRevision,
    },
    reviewRevisionSha256: input.reviewRevisionSha256,
    generation: input.generation,
  });
}

export function tabularCellIdempotencyKey(payload: TabularCellJobPayload) {
  return `vera:tabular-cell:${payload.cellId}:${payload.generationId}:g${payload.generation}:${tabularGenerationSha256(payload)}`;
}
