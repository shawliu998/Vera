import { createHash } from "node:crypto";
import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "./migrations";
import type { TabularReviewDetail } from "./repositories/tabular";
import {
  TabularCellJobPayloadSchema,
  tabularColumnRevisionSha256,
  tabularGenerationSha256,
  tabularReviewRevisionSha256,
} from "./tabularGenerationContract";

export const TABULAR_REVIEW_STUDIO_MANIFEST_MAX_BYTES_V23 = 4_000_000;
export const TABULAR_REVIEW_STUDIO_MAX_CITATIONS_V23 = 200;
export const TABULAR_REVIEW_STUDIO_REDUCER_REVISION_V23 =
  "vera-contract-review-memo-reducer-v23-1";

export const TABULAR_REVIEW_STUDIO_REDUCER_REVISION_SHA256_V23 = createHash(
  "sha256",
)
  .update(TABULAR_REVIEW_STUDIO_REDUCER_REVISION_V23, "utf8")
  .digest("hex");

const Id = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const TabularReviewStudioHandoffPersistenceV23Schema = z
  .object({
    id: Id,
    identitySha256: Sha256,
    projectId: Id,
    reviewId: Id,
    expectedReviewUpdatedAt: z.string().datetime({ precision: 3 }),
    reviewStateSha256: Sha256,
    sourceManifestJson: z
      .string()
      .min(2)
      .max(TABULAR_REVIEW_STUDIO_MANIFEST_MAX_BYTES_V23),
    sourceManifestSha256: Sha256,
    templateReducerRevisionSha256: z.literal(
      TABULAR_REVIEW_STUDIO_REDUCER_REVISION_SHA256_V23,
    ),
    documentId: Id,
    versionId: Id,
    documentType: z.literal("contract_review_memo"),
    createdAt: z.string().datetime({ precision: 3 }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Buffer.byteLength(value.sourceManifestJson, "utf8") >
      TABULAR_REVIEW_STUDIO_MANIFEST_MAX_BYTES_V23
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceManifestJson"],
        message: "source manifest exceeds the bounded UTF-8 size",
      });
    }
    if (
      createHash("sha256")
        .update(value.sourceManifestJson, "utf8")
        .digest("hex") !== value.sourceManifestSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceManifestSha256"],
        message: "source manifest digest does not match its canonical bytes",
      });
    }
  });

export type TabularReviewStudioHandoffPersistenceV23 = z.infer<
  typeof TabularReviewStudioHandoffPersistenceV23Schema
>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalJsonV23(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonV23(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonV23(value[key] as Json)}`,
    )
    .join(",")}}`;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const TabularCellJobResultV23Schema = z
  .object({
    schema: z.literal("vera-tabular-cell-result-v1"),
    cellId: Id,
    contentSha256: Sha256,
    sourceCount: z.number().int().nonnegative().max(1000),
  })
  .strict();

export type TabularReviewStudioJobLineageV23 = Readonly<{
  cellId: string;
  jobId: string;
  generation: number;
  documentVersionId: string;
  columnRevisionSha256: string;
  reviewRevisionSha256: string;
  jobPayloadSha256: string;
  jobResultSha256: string;
}>;

function parseStoredJsonV23(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} is not stored as JSON text.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

export function readTabularReviewStudioJobLineageV23(input: {
  database: WorkspaceDatabaseAdapter;
  projectId: string;
  detail: TabularReviewDetail;
}): TabularReviewStudioJobLineageV23[] {
  const { review, columns, cells } = input.detail;
  const rows = input.database
    .prepare(
      `SELECT cell.id AS cell_id, cell.job_id AS cell_job_id,
              cell.attempt AS cell_attempt,
              cell.completed_at AS cell_completed_at,
              job.id AS job_id, job.type AS job_type,
              job.resource_type AS job_resource_type,
              job.resource_id AS job_resource_id,
              job.status AS job_status,
              job.payload_json AS job_payload_json,
              job.result_json AS job_result_json,
              job.completed_at AS job_completed_at
         FROM tabular_cells cell
         LEFT JOIN jobs job ON job.id = cell.job_id
        WHERE cell.review_id = ?`,
    )
    .all(review.id);
  if (rows.length !== cells.length || review.projectId !== input.projectId) {
    throw new Error("Tabular review job lineage is incomplete.");
  }
  const rowByCellId = new Map(rows.map((row) => [String(row.cell_id), row]));
  const columnById = new Map(columns.map((column) => [column.id, column]));
  const snapshotByVersionId = new Map<string, Record<string, unknown>>();
  const reviewRevisionSha256 = tabularReviewRevisionSha256({
    reviewId: review.id,
    projectId: input.projectId,
    workflowId: review.workflowId,
    documentIds: review.documentIds,
    columns,
  });
  return cells.map((cell) => {
    const row = rowByCellId.get(cell.id);
    const column = columnById.get(cell.columnId);
    const payload = TabularCellJobPayloadSchema.safeParse(
      parseStoredJsonV23(row?.job_payload_json, "Tabular job payload"),
    );
    const result = TabularCellJobResultV23Schema.safeParse(
      parseStoredJsonV23(row?.job_result_json, "Tabular job result"),
    );
    const jobId = row?.job_id == null ? null : String(row.job_id);
    const columnRevisionSha256 = column
      ? tabularColumnRevisionSha256(column)
      : null;
    const payloadVersionId = payload.success
      ? payload.data.document.versionId
      : "";
    let snapshot = snapshotByVersionId.get(payloadVersionId);
    if (!snapshot && payloadVersionId) {
      snapshot = input.database
        .prepare(
          `SELECT document.project_id AS project_id,
                  version.content_sha256 AS source_content_sha256,
                  blob.id AS blob_record_id,
                  blob.content_sha256 AS text_sha256,
                  blob.size_bytes AS text_bytes
             FROM documents document
             JOIN document_versions version
               ON version.document_id = document.id
              AND version.id = ?
              AND version.deleted_at IS NULL
             JOIN workspace_blob_records blob
               ON blob.kind = 'extracted_text'
              AND blob.document_id = document.id
              AND blob.version_id = version.id
              AND blob.state = 'stored'
            WHERE document.id = ?
              AND document.deleted_at IS NULL`,
        )
        .get(payloadVersionId, cell.documentId);
      if (snapshot) snapshotByVersionId.set(payloadVersionId, snapshot);
    }
    if (
      !row ||
      !column ||
      columnRevisionSha256 === null ||
      !payload.success ||
      !result.success ||
      !snapshot ||
      cell.status !== "complete" ||
      cell.content === null ||
      cell.jobId === null ||
      cell.completedAt === null ||
      row.cell_job_id !== cell.jobId ||
      jobId !== cell.jobId ||
      row.job_type !== "tabular_cell" ||
      row.job_resource_type !== "tabular_cell" ||
      row.job_resource_id !== cell.id ||
      row.job_status !== "complete" ||
      row.job_completed_at !== cell.completedAt ||
      Number(row.cell_attempt) !== cell.attempt ||
      payload.data.reviewId !== review.id ||
      payload.data.projectId !== input.projectId ||
      payload.data.cellId !== cell.id ||
      payload.data.generationId !== cell.jobId ||
      payload.data.generation !== cell.attempt ||
      payload.data.document.documentId !== cell.documentId ||
      snapshot.project_id !== input.projectId ||
      snapshot.blob_record_id !== payload.data.document.blobRecordId ||
      snapshot.source_content_sha256 !==
        payload.data.document.sourceContentSha256 ||
      snapshot.text_sha256 !== payload.data.document.textSha256 ||
      Number(snapshot.text_bytes) !== payload.data.document.textBytes ||
      payload.data.column.columnId !== cell.columnId ||
      payload.data.column.revisionSha256 !== columnRevisionSha256 ||
      payload.data.reviewRevisionSha256 !== reviewRevisionSha256 ||
      payload.data.model.profileId !== review.modelProfileId ||
      cell.sourceRefs.some(
        (source) => source.versionId !== payload.data.document.versionId,
      ) ||
      result.data.cellId !== cell.id ||
      result.data.sourceCount !== cell.sourceRefs.length ||
      result.data.contentSha256 !==
        tabularGenerationSha256({
          content: cell.content,
          sources: cell.sourceRefs,
        })
    ) {
      throw new Error(
        "Completed Tabular cells do not have exact durable generation lineage.",
      );
    }
    return {
      cellId: cell.id,
      jobId: cell.jobId,
      generation: cell.attempt,
      documentVersionId: payload.data.document.versionId,
      columnRevisionSha256,
      reviewRevisionSha256,
      jobPayloadSha256: tabularGenerationSha256(payload.data),
      jobResultSha256: tabularGenerationSha256(result.data),
    };
  });
}

function canonicalSource(
  source: TabularReviewDetail["cells"][number]["sourceRefs"][number],
) {
  if (
    source.versionId == null ||
    source.chunkId == null ||
    source.quote == null ||
    source.startOffset == null ||
    source.endOffset == null ||
    source.quote.length === 0 ||
    source.endOffset !== source.startOffset + source.quote.length
  ) {
    throw new Error(
      "Every contract-review citation requires versionId, chunkId, quote, startOffset, and endOffset.",
    );
  }
  return {
    documentId: source.documentId,
    versionId: source.versionId,
    chunkId: source.chunkId,
    quote: source.quote,
    startOffset: source.startOffset,
    endOffset: source.endOffset,
  };
}

export function prepareTabularReviewStudioSourceV23(input: {
  projectId: string;
  detail: TabularReviewDetail;
  jobLineage: readonly TabularReviewStudioJobLineageV23[];
}) {
  const { review, columns, cells } = input.detail;
  if (
    review.projectId !== input.projectId ||
    review.status !== "complete" ||
    review.workflowId == null
  ) {
    throw new Error(
      "Only a completed workflow-bound review in this Matter can create a contract-review memo.",
    );
  }
  const completed = cells.filter((cell) => cell.status === "complete");
  const lineageByCellId = new Map(
    input.jobLineage.map((lineage) => [lineage.cellId, lineage]),
  );
  if (
    completed.length === 0 ||
    completed.length !== cells.length ||
    lineageByCellId.size !== cells.length ||
    completed.some(
      (cell) =>
        cell.jobId == null ||
        cell.attempt < 1 ||
        cell.completedAt == null ||
        cell.content == null ||
        cell.sourceRefs.length === 0,
    )
  ) {
    throw new Error(
      "Every review cell must be complete and carry durable attempt/job lineage plus at least one source citation before creating a memo.",
    );
  }
  const manifest = {
    schema: "vera-tabular-review-studio-source-manifest-v1",
    reducerRevisionSha256: TABULAR_REVIEW_STUDIO_REDUCER_REVISION_SHA256_V23,
    review: {
      id: review.id,
      projectId: review.projectId,
      workflowId: review.workflowId,
      title: review.title,
      status: review.status,
      documentIds: [...review.documentIds],
      updatedAt: review.updatedAt,
    },
    columns: columns.map((column) => ({
      id: column.id,
      key: column.key,
      title: column.title,
      outputType: column.outputType,
      format: column.format,
      prompt: column.prompt,
      enumValues: column.enumValues,
      tags: [...column.tags],
      ordinal: column.ordinal,
    })),
    cells: completed.map((cell) => {
      const lineage = lineageByCellId.get(cell.id);
      if (!lineage || lineage.jobId !== cell.jobId) {
        throw new Error("Tabular review job lineage does not match its cells.");
      }
      return {
        id: cell.id,
        reviewId: cell.reviewId,
        documentId: cell.documentId,
        columnId: cell.columnId,
        outputType: cell.outputType,
        status: cell.status,
        attempt: cell.attempt,
        jobId: cell.jobId,
        jobLineage: lineage,
        content: cell.content,
        completedAt: cell.completedAt,
        sourceRefs: cell.sourceRefs.map(canonicalSource),
      };
    }),
  } satisfies Json;
  const sourceManifestJson = canonicalJsonV23(manifest);
  if (
    Buffer.byteLength(sourceManifestJson, "utf8") >
    TABULAR_REVIEW_STUDIO_MANIFEST_MAX_BYTES_V23
  ) {
    throw new Error(
      "The review evidence manifest exceeds the Studio handoff limit.",
    );
  }
  const orderedUniqueSources: ReturnType<typeof canonicalSource>[] = [];
  const sourceKeys = new Set<string>();
  for (const cell of manifest.cells) {
    for (const source of cell.sourceRefs) {
      const key = canonicalJsonV23(source);
      if (!sourceKeys.has(key)) {
        sourceKeys.add(key);
        orderedUniqueSources.push(source);
      }
    }
  }
  if (orderedUniqueSources.length === 0) {
    throw new Error(
      "At least one completed review cell must contain a durable source citation.",
    );
  }
  if (orderedUniqueSources.length > TABULAR_REVIEW_STUDIO_MAX_CITATIONS_V23) {
    throw new Error("The review contains too many unique Studio citations.");
  }
  const reviewStateSha256 = digest(
    canonicalJsonV23({
      review: manifest.review,
      columns: manifest.columns,
      cells: manifest.cells,
    }),
  );
  const sourceManifestSha256 = digest(sourceManifestJson);
  const identitySha256 = digest(
    canonicalJsonV23({
      projectId: input.projectId,
      reviewId: review.id,
      reviewStateSha256,
      sourceManifestSha256,
      templateReducerRevisionSha256:
        TABULAR_REVIEW_STUDIO_REDUCER_REVISION_SHA256_V23,
    }),
  );
  return {
    manifest,
    sourceManifestJson,
    sourceManifestSha256,
    reviewStateSha256,
    identitySha256,
    orderedUniqueSources,
  };
}

function markdownText(value: string) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
}

export function reduceTabularReviewToContractMemoV23(
  prepared: ReturnType<typeof prepareTabularReviewStudioSourceV23>,
) {
  const { manifest, orderedUniqueSources } = prepared;
  const sourceNumber = new Map(
    orderedUniqueSources.map((source, index) => [
      canonicalJsonV23(source),
      index + 1,
    ]),
  );
  const columnById = new Map(
    manifest.columns.map((column) => [column.id, column]),
  );
  const flagged = manifest.cells.filter(
    (cell) => cell.content?.flag === "red" || cell.content?.flag === "yellow",
  );
  const issues = manifest.cells.map((cell) => {
    const column = columnById.get(cell.columnId);
    const markers = cell.sourceRefs
      .map((source) => sourceNumber.get(canonicalJsonV23(source)))
      .filter((value): value is number => value !== undefined)
      .map((value) => `[${value}]`)
      .join(" ");
    const summary = markdownText(cell.content?.summary ?? "未形成摘要");
    const reasoning = markdownText(cell.content?.reasoning ?? "");
    return [
      `### ${markdownText(column?.title ?? "审查事项")}`,
      `- 模型提取标记：${cell.content?.flag ?? "grey"}（仅供律师核验，不表示风险等级）`,
      `- 审查结论：${summary}${markers ? ` ${markers}` : ""}`,
      ...(reasoning ? [`- 分析与修改建议：${reasoning}`] : []),
    ].join("\n");
  });
  const content = [
    "# 合同审查备忘录",
    "",
    "> AI 生成草稿，仅供工作参考；提交、发送或据此采取行动前须由律师逐项复核。",
    "",
    "## 交易背景与审查范围",
    "",
    `- Tabular Review：${markdownText(manifest.review.title)}`,
    `- 审查文件数：${manifest.review.documentIds.length}`,
    `- 完成审查单元：${manifest.cells.length}`,
    "",
    "## 执行摘要",
    "",
    `共有 ${flagged.length} 个审查单元带 red 或 yellow 持久化模型标记；该计数不表示风险等级、模型一致性或其余单元不存在风险。`,
    "",
    "## 条款问题清单",
    "",
    ...issues.flatMap((issue) => [issue, ""]),
    "## 谈判优先级",
    "",
    "以下内容可按持久化模型标记分组供律师核验；颜色不表示风险等级、审查优先级、模型一致性或不存在风险。具体谈判顺序须由律师结合合同全文、代表方与商业底线决定。",
    "",
    "## 待补充信息",
    "",
    "请补充交易目标、代表方、商业底线、缺失附件、授权与审批信息，并核验所有引用位置。",
    "",
  ].join("\n");
  const titleSuffix = " — 合同审查备忘录";
  const title = `${[...manifest.review.title].slice(0, 240 - [...titleSuffix].length).join("")}${titleSuffix}`;
  return { title, content };
}
