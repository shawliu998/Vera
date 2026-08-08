import { createHash } from "node:crypto";

import { z } from "zod";

import { readAgentStepEffectReceipts } from "./agent-kernel/effects/stepEffect";
import { readAgentStepTabularEffectReceipts } from "./agent-kernel/effects/tabularEffect";
import { buildAgentStepTabularEffectReservation } from "./agent-kernel/effects/tabularEffect";
import { readFixedMatterContext } from "./agent-kernel/context/matterContext";
import {
  buildAgentVerificationPacketV1,
  detectArtifactIncompleteEnding,
  type AgentVerificationPacketV1,
  type AgentVerifierDeterministicIssueV1,
  type AgentVerifierProfileV1,
} from "./agent-kernel/verification/verifierCore";
import {
  findDeliverableArtifact,
  requiredTaskDeliverables,
  taskDeliverablePurpose,
} from "./agentTaskDeliverables";
import type { AgentArtifactLinkInput } from "./agentTasks";
import { extractDocxBodyText } from "./docxTrackedChanges";
import { spreadsheetToLLMText } from "./spreadsheet";
import { downloadFile } from "./storage";
import type { createServerSupabase } from "./supabase";
import { buildAgentPackDeterministicChecks } from "./agentPackVerifierRegistry";
import { litigationEvidenceInventoryReceiptSchema } from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import { litigationEvidenceReviewCompletionReceiptSchema } from "./agent-packs/litigation/litigationEvidenceInventoryReview";
import { readCurrentLitigationEvidenceInventoryBinding } from "./agentLitigationEvidenceInventoryBinding";
import {
  buildLitigationEvidenceEffectLayout,
  buildLitigationEvidenceReviewSpec,
} from "./agentLitigationEvidenceInventoryExecutor";
import {
  verifiedArtifactIdentitySchema,
  verifiedTabularArtifactIdentitySchema,
  type VerifiedArtifactIdentity,
} from "./agent-kernel/contracts/verifiedArtifactIdentity";
import { assertLitigationVerifiedTabularArtifact } from "./agent-packs/litigation/litigationEvidenceInventoryVerifiedArtifact";
import {
  buildAgentTabularAcceptedView,
  isAgentTabularAcceptedViewBuildError,
  sha256AgentArtifact,
} from "./agentTabularAcceptedView";

type Db = ReturnType<typeof createServerSupabase>;

type VerificationSnapshot = {
  task: {
    id: string;
    matter_id: string;
    goal: string;
    deliverables?: unknown;
    latest_checkpoint?: unknown;
    current_plan: Array<{
      id: string;
      status: string;
      attempt: number;
      result_data?: unknown;
    }>;
  };
  artifacts: AgentArtifactLinkInput[];
};

type CitationCoverage = {
  total: number;
  relocatable: number;
  missing: number;
};

type MutableCheck = AgentVerificationPacketV1["deterministic_checks"][number];

export type CurrentAgentVerification = {
  packet: AgentVerificationPacketV1;
  /** Internal server data; intentionally absent from the model packet. */
  verifiedArtifacts: VerifiedArtifactIdentity[];
};

type TabularRevisionIdentity = {
  revision_fingerprint: string;
};

type TabularReviewRow = {
  id: string;
  project_id: string | null;
  user_id: string | null;
  title: string | null;
  practice: string | null;
  row_protocol: string | null;
  workflow_id: string | null;
  document_ids: unknown;
  columns_config: unknown;
};

type TabularCellRow = {
  id: string;
  review_id: string;
  document_id: string | null;
  row_id: string | null;
  column_index: number | null;
  content: string | null;
  citations: unknown;
  status: string | null;
  review_status?: string | null;
  reviewed_at?: string | null;
  review_revision?: number | null;
};

type TabularReviewValidation =
  | {
      status: "invalid";
      reason: "row_protocol" | "layout" | "source_scope" | "cell_coordinate";
      totalCells: number;
    }
  | {
      status: "valid";
      documentIds: string[];
      columnIndexes: number[];
      cellsByCoordinate: Map<string, TabularCellRow>;
      incompleteCells: number;
      totalCells: number;
    };

export const MAX_VERIFIER_DELIVERABLE_PROJECTION_CHARS = 80_000;
export const MAX_VERIFIER_PACKET_PROJECTION_CHARS = 160_000;
export const MAX_VERIFIER_TABULAR_REVIEW_CELLS = 500;

function passCheck(
  code: string,
  dimension: MutableCheck["dimension"],
  detail: string,
): MutableCheck {
  return { code, dimension, status: "pass", detail, issue: null };
}

function gapCheck(
  code: string,
  dimension: MutableCheck["dimension"],
  detail: string,
  issue: AgentVerifierDeterministicIssueV1,
): MutableCheck {
  return { code, dimension, status: "gap", detail, issue };
}

function acceptedViewSha256(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function tabularCoordinate(documentId: string, columnIndex: number) {
  return `${documentId}:${columnIndex}`;
}

function tabularDocumentIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
  return ids.length === value.length && new Set(ids).size === ids.length
    ? ids
    : null;
}

function tabularColumnIndexes(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const indexes = value.map((column) =>
    column &&
    typeof column === "object" &&
    !Array.isArray(column) &&
    Number.isInteger((column as Record<string, unknown>).index) &&
    Number((column as Record<string, unknown>).index) >= 0
      ? Number((column as Record<string, unknown>).index)
      : null,
  );
  return indexes.every((index): index is number => index !== null) &&
    new Set(indexes).size === indexes.length
    ? (indexes as number[])
    : null;
}

function validateTabularReview(input: {
  review: TabularReviewRow;
  cells: TabularCellRow[];
  documentById: Map<string, Record<string, unknown>>;
  matterId: string;
  userId: string;
}): TabularReviewValidation {
  if (input.review.row_protocol !== "document_rows") {
    return {
      status: "invalid",
      reason: "row_protocol",
      totalCells: input.cells.length,
    };
  }
  const documentIds = tabularDocumentIds(input.review.document_ids);
  const columnIndexes = tabularColumnIndexes(input.review.columns_config);
  if (!documentIds || !columnIndexes) {
    return {
      status: "invalid",
      reason: "layout",
      totalCells: input.cells.length,
    };
  }
  if (
    documentIds.some((documentId) => {
      const document = input.documentById.get(documentId);
      return (
        !document ||
        document.project_id !== input.matterId ||
        document.user_id !== input.userId
      );
    })
  ) {
    return {
      status: "invalid",
      reason: "source_scope",
      totalCells: input.cells.length,
    };
  }
  const expected = new Set(
    documentIds.flatMap((documentId) =>
      columnIndexes.map((columnIndex) =>
        tabularCoordinate(documentId, columnIndex),
      ),
    ),
  );
  const cellsByCoordinate = new Map<string, TabularCellRow>();
  for (const cell of input.cells) {
    if (
      cell.review_id !== input.review.id ||
      cell.row_id !== null ||
      !cell.document_id
    ) {
      return {
        status: "invalid",
        reason: "cell_coordinate",
        totalCells: input.cells.length,
      };
    }
    if (
      typeof cell.column_index !== "number" ||
      !Number.isInteger(cell.column_index)
    ) {
      return {
        status: "invalid",
        reason: "cell_coordinate",
        totalCells: input.cells.length,
      };
    }
    const columnIndex = cell.column_index;
    if (!expected.has(tabularCoordinate(cell.document_id, columnIndex))) {
      return {
        status: "invalid",
        reason: "cell_coordinate",
        totalCells: input.cells.length,
      };
    }
    const coordinate = tabularCoordinate(cell.document_id, columnIndex);
    if (cellsByCoordinate.has(coordinate)) {
      return {
        status: "invalid",
        reason: "cell_coordinate",
        totalCells: input.cells.length,
      };
    }
    cellsByCoordinate.set(coordinate, cell);
  }
  if (cellsByCoordinate.size !== expected.size) {
    return {
      status: "invalid",
      reason: "cell_coordinate",
      totalCells: input.cells.length,
    };
  }
  const incompleteCells = Array.from(cellsByCoordinate.values()).filter(
    (cell) =>
      cell.status !== "done" ||
      typeof cell.content !== "string" ||
      cell.content.trim().length === 0,
  ).length;
  return {
    status: "valid",
    documentIds,
    columnIndexes,
    cellsByCoordinate,
    incompleteCells,
    totalCells: cellsByCoordinate.size,
  };
}

function tabularReviewAcceptedView(input: {
  review: TabularReviewRow;
  documentIds: string[];
  columnIndexes: number[];
  cellsByCoordinate: Map<string, TabularCellRow>;
}) {
  const lines = [
    "# Tabular Review accepted view",
    `Title: ${input.review.title?.trim() || "Untitled review"}`,
    "Row protocol: document_rows",
    `Document rows: ${input.documentIds.join(", ")}`,
    `Columns: ${canonical(input.review.columns_config)}`,
    "Cells:",
  ];
  for (const documentId of input.documentIds) {
    for (const columnIndex of input.columnIndexes) {
      const cell = input.cellsByCoordinate.get(
        tabularCoordinate(documentId, columnIndex),
      );
      if (!cell) continue;
      lines.push(
        [
          `document_id=${documentId}`,
          `column_index=${columnIndex}`,
          `status=${cell.status ?? ""}`,
          `review_status=${cell.review_status ?? ""}`,
          `reviewed_at=${cell.reviewed_at ?? ""}`,
          `review_revision=${cell.review_revision ?? ""}`,
          `content=${cell.content ?? ""}`,
          `citations=${canonical(cell.citations)}`,
        ].join(" | "),
      );
    }
  }
  return lines.join("\n");
}

function projectAcceptedView(input: {
  acceptedView: string;
  remainingCharacters: number;
}) {
  const projectedCharacters = Math.min(
    input.acceptedView.length,
    MAX_VERIFIER_DELIVERABLE_PROJECTION_CHARS,
    input.remainingCharacters,
  );
  const projectionComplete = projectedCharacters === input.acceptedView.length;
  return {
    projectedCharacters,
    projectionComplete,
    projection: projectionComplete
      ? input.acceptedView
      : projectedCharacters === 0
        ? null
        : [
            input.acceptedView.slice(0, Math.floor(projectedCharacters / 2)),
            "\n[INCOMPLETE VERIFICATION PROJECTION — MIDDLE OMITTED]\n",
            input.acceptedView.slice(
              input.acceptedView.length - Math.ceil(projectedCharacters / 2),
            ),
          ].join(""),
  };
}

async function extractAcceptedView(version: {
  storage_path?: string | null;
  file_type?: string | null;
}) {
  if (!version.storage_path) return null;
  const raw = await downloadFile(version.storage_path);
  if (!raw) return null;
  const bytes = Buffer.from(raw);
  const fileType = (version.file_type ?? "").toLowerCase();
  if (fileType === "docx") return extractDocxBodyText(bytes);
  if (["xlsx", "xlsm", "xls"].includes(fileType)) {
    return spreadsheetToLLMText(bytes);
  }
  return null;
}

function fixedCreatedVersionByDocument(snapshot: VerificationSnapshot) {
  const latest = new Map<
    string,
    {
      stepIndex: number;
      attempt: number;
      committedAt: string;
      effectKey: string;
      versionId: string;
    }
  >();
  snapshot.task.current_plan.forEach((step, stepIndex) => {
    for (const receipt of readAgentStepEffectReceipts(step.result_data)) {
      if (
        receipt.status !== "committed" ||
        !receipt.effect ||
        receipt.step_id !== step.id ||
        receipt.attempt > step.attempt
      ) {
        continue;
      }
      const candidate = {
        stepIndex,
        attempt: receipt.attempt,
        committedAt: receipt.committed_at!,
        effectKey: receipt.effect_key,
        versionId: receipt.effect.version_id,
      };
      const current = latest.get(receipt.effect.document_id);
      if (
        !current ||
        candidate.stepIndex > current.stepIndex ||
        (candidate.stepIndex === current.stepIndex &&
          (candidate.attempt > current.attempt ||
            (candidate.attempt === current.attempt &&
              (candidate.committedAt > current.committedAt ||
                (candidate.committedAt === current.committedAt &&
                  candidate.effectKey > current.effectKey)))))
      ) {
        latest.set(receipt.effect.document_id, candidate);
      }
    }
  });
  return new Map(
    Array.from(latest, ([documentId, receipt]) => [
      documentId,
      receipt.versionId,
    ]),
  );
}

function committedTabularInputDigest(
  snapshot: VerificationSnapshot,
  reviewId: string,
  litigationBinding: ReturnType<
    typeof readCurrentLitigationEvidenceInventoryBinding
  > | null,
) {
  if (litigationBinding?.status === "valid") {
    const spec = buildLitigationEvidenceReviewSpec(
      litigationBinding.binding.receipt,
    );
    return buildAgentStepTabularEffectReservation({
      stepId: litigationBinding.binding.receipt.step_id,
      attempt: litigationBinding.binding.receipt.attempt,
      reviewId: litigationBinding.binding.receipt.review_id,
      layout: buildLitigationEvidenceEffectLayout(spec),
      createdAt: "2026-01-01T00:00:00.000Z",
    }).input_fingerprint;
  }
  const fingerprints = snapshot.task.current_plan.flatMap((step) =>
    readAgentStepTabularEffectReceipts(step.result_data).flatMap((receipt) =>
      receipt.status === "committed" &&
      receipt.step_id === step.id &&
      receipt.attempt === step.attempt &&
      receipt.target.review_id === reviewId &&
      receipt.effect?.review_id === reviewId
        ? [receipt.input_fingerprint]
        : [],
    ),
  );
  const unique = Array.from(new Set(fingerprints));
  return unique.length === 1 ? unique[0]! : null;
}

function tabularRevisionUnstableGap(input: {
  key: string;
  reviewId: string;
  totalCells: number;
  reason:
    | "input_digest_unavailable"
    | "input_digest_changed"
    | "before_unavailable"
    | "after_unavailable"
    | "changed";
}) {
  return gapCheck(
    `tabular-review-revision:${input.key}`,
    "artifact_integrity",
    "The server could not establish one stable current Tabular Review identity; the current Review is preserved for lawyer review.",
    {
      code: "tabular_review_revision_unstable",
      deliverable_key: input.key,
      review_id: input.reviewId,
      reason: input.reason,
      total_cells: input.totalCells,
    },
  );
}

async function readCurrentTabularReviewState(input: {
  db: Db;
  reviewId: string;
}) {
  const [reviewResult, cellsResult] = await Promise.all([
    input.db
      .from("tabular_reviews")
      .select(
        "id,project_id,user_id,title,practice,row_protocol,workflow_id,document_ids,columns_config",
      )
      .in("id", [input.reviewId]),
    input.db
      .from("tabular_cells")
      .select(
        "id,review_id,document_id,row_id,column_index,content,citations,status,review_status,reviewed_at,review_revision",
      )
      .in("review_id", [input.reviewId])
      .limit(MAX_VERIFIER_TABULAR_REVIEW_CELLS + 1),
  ]);
  if (reviewResult.error) throw new Error(reviewResult.error.message);
  if (cellsResult.error) throw new Error(cellsResult.error.message);
  const review = ((reviewResult.data ?? []) as TabularReviewRow[])[0] ?? null;
  return {
    review,
    cells: (cellsResult.data ?? []) as TabularCellRow[],
  };
}

async function readCurrentTabularRevisionIdentity(input: {
  db: Db;
  taskId: string;
  userId: string;
  reviewId: string;
  inputDigest: string;
}) {
  const { data, error } = await input.db.rpc(
    "read_agent_tabular_review_revision_fingerprint_v1",
    {
      p_task_id: input.taskId,
      p_user_id: input.userId,
      p_review_id: input.reviewId,
      p_expected_input_digest: input.inputDigest,
    },
  );
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (row?.outcome !== "current") return null;
  const parsed = z
    .object({
      outcome: z.literal("current"),
      revision_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .safeParse(row);
  if (!parsed.success) return null;
  return {
    revision_fingerprint: parsed.data.revision_fingerprint,
  };
}

function deliverableKey(deliverable: {
  key?: string;
  title?: string;
  purpose?: string;
}) {
  return deliverable.key?.trim() || taskDeliverablePurpose(deliverable);
}

export async function buildCurrentAgentVerificationPacket(input: {
  db: Db;
  snapshot: VerificationSnapshot;
  userId: string;
  stepId: string;
  stepAttempt: number;
  profile: AgentVerifierProfileV1;
  citationsRequired: boolean;
  citationCoverage: CitationCoverage;
  loadAcceptedView?: typeof extractAcceptedView;
  readTabularRevisionIdentity?: (input: {
    taskId: string;
    userId: string;
    reviewId: string;
    inputDigest: string;
  }) => Promise<TabularRevisionIdentity | null>;
}): Promise<CurrentAgentVerification> {
  const checkpoint =
    input.snapshot.task.latest_checkpoint &&
    typeof input.snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(input.snapshot.task.latest_checkpoint)
      ? (input.snapshot.task.latest_checkpoint as Record<string, unknown>)
      : {};
  const litigationReceipt = litigationEvidenceInventoryReceiptSchema.safeParse(
    checkpoint.litigation_evidence_inventory_receipt,
  );
  const litigationCompletion =
    litigationEvidenceReviewCompletionReceiptSchema.safeParse(
      checkpoint.litigation_evidence_review_completion,
    );
  const required = requiredTaskDeliverables(input.snapshot.task);
  const artifacts = required.map((deliverable) => ({
    deliverable,
    key: deliverableKey(deliverable),
    artifact: findDeliverableArtifact(deliverable, input.snapshot.artifacts),
  }));
  const documentArtifactIds = Array.from(
    new Set(
      artifacts.flatMap(({ artifact }) =>
        artifact && artifact.artifact_type !== "tabular_review"
          ? [artifact.artifact_id]
          : [],
      ),
    ),
  );
  const tabularReviewIds = Array.from(
    new Set(
      artifacts.flatMap(({ artifact }) =>
        artifact?.artifact_type === "tabular_review"
          ? [artifact.artifact_id]
          : [],
      ),
    ),
  );
  const { data: reviews, error: reviewsError } = tabularReviewIds.length
    ? await input.db
        .from("tabular_reviews")
        .select(
          "id,project_id,user_id,title,practice,row_protocol,workflow_id,document_ids,columns_config",
        )
        .in("id", tabularReviewIds)
    : { data: [], error: null };
  if (reviewsError) throw new Error(reviewsError.message);
  const reviewById = new Map(
    ((reviews ?? []) as TabularReviewRow[]).map((review) => [
      review.id,
      review,
    ]),
  );
  const tabularCellResults = await Promise.all(
    tabularReviewIds.map((reviewId) =>
      input.db
        .from("tabular_cells")
        .select(
          "id,review_id,document_id,row_id,column_index,content,citations,status,review_status,reviewed_at,review_revision",
        )
        .in("review_id", [reviewId])
        .limit(MAX_VERIFIER_TABULAR_REVIEW_CELLS + 1),
    ),
  );
  const tabularCellsError = tabularCellResults.find(
    (result) => result.error,
  )?.error;
  if (tabularCellsError) throw new Error(tabularCellsError.message);
  const tabularCells = tabularCellResults.flatMap(
    (result) => result.data ?? [],
  );
  const cellsByReviewId = new Map<string, TabularCellRow[]>();
  for (const cell of (tabularCells ?? []) as TabularCellRow[]) {
    const existing = cellsByReviewId.get(cell.review_id) ?? [];
    existing.push(cell);
    cellsByReviewId.set(cell.review_id, existing);
  }
  const tabularSourceDocumentIds = Array.from(
    new Set([
      ...((reviews ?? []) as TabularReviewRow[]).flatMap(
        (review) => tabularDocumentIds(review.document_ids) ?? [],
      ),
      ...((tabularCells ?? []) as TabularCellRow[]).flatMap((cell) =>
        cell.document_id ? [cell.document_id] : [],
      ),
    ]),
  );
  const documentIds = Array.from(
    new Set([...documentArtifactIds, ...tabularSourceDocumentIds]),
  );
  const { data: documents, error: documentsError } = documentIds.length
    ? await input.db
        .from("documents")
        .select("id,user_id,project_id,current_version_id")
        .in("id", documentIds)
    : { data: [], error: null };
  if (documentsError) throw new Error(documentsError.message);
  const documentById = new Map(
    (documents ?? []).map((document) => [document.id as string, document]),
  );
  const currentVersionIds = Array.from(
    new Set(
      (documents ?? []).flatMap((document) =>
        documentArtifactIds.includes(document.id as string) &&
        typeof document.current_version_id === "string" &&
        document.current_version_id
          ? [document.current_version_id]
          : [],
      ),
    ),
  );
  const { data: versions, error: versionsError } = currentVersionIds.length
    ? await input.db
        .from("document_versions")
        .select("id,document_id,storage_path,file_type,deleted_at")
        .in("id", currentVersionIds)
    : { data: [], error: null };
  if (versionsError) throw new Error(versionsError.message);
  const versionById = new Map(
    (versions ?? []).map((version) => [version.id as string, version]),
  );
  const expectedVersionByDocument = fixedCreatedVersionByDocument(
    input.snapshot,
  );
  const checks: MutableCheck[] = [];
  const deliverables: AgentVerificationPacketV1["deliverables"] = [];
  const verifiedArtifacts: VerifiedArtifactIdentity[] = [];
  let remainingProjectionCharacters = MAX_VERIFIER_PACKET_PROJECTION_CHARS;

  for (const item of artifacts) {
    const artifactType =
      item.artifact?.artifact_type === "tabular_review" ||
      item.deliverable.artifact_type === "tabular_review"
        ? "tabular_review"
        : "draft";
    if (!item.artifact) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: null,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-present:${item.key}`,
          "artifact_integrity",
          `${item.key} has no linked current Artifact.`,
          {
            code: "artifact_missing",
            deliverable_key: item.key,
            artifact_type: artifactType,
          },
        ),
      );
      continue;
    }
    if (artifactType === "tabular_review") {
      const review = reviewById.get(item.artifact.artifact_id);
      if (!review) {
        deliverables.push({
          key: item.key,
          artifact_type: artifactType,
          artifact_id: item.artifact.artifact_id,
          document_id: null,
          current_version_id: null,
          accepted_view_sha256: null,
          accepted_view_text: null,
          accepted_view_complete: false,
        });
        checks.push(
          gapCheck(
            `artifact-available:${item.key}`,
            "artifact_integrity",
            `${item.key} does not resolve to an available Tabular Review.`,
            {
              code: "artifact_unavailable",
              deliverable_key: item.key,
              artifact_id: item.artifact.artifact_id,
            },
          ),
        );
        continue;
      }
      if (
        review.project_id !== input.snapshot.task.matter_id ||
        review.user_id !== input.userId
      ) {
        deliverables.push({
          key: item.key,
          artifact_type: artifactType,
          artifact_id: item.artifact.artifact_id,
          document_id: null,
          current_version_id: null,
          accepted_view_sha256: null,
          accepted_view_text: null,
          accepted_view_complete: false,
        });
        checks.push(
          gapCheck(
            `artifact-matter:${item.key}`,
            "artifact_integrity",
            `${item.key} is outside the fixed Matter or owner scope.`,
            {
              code: "artifact_outside_matter",
              deliverable_key: item.key,
              artifact_id: item.artifact.artifact_id,
            },
          ),
        );
        continue;
      }
      const reviewCells = cellsByReviewId.get(review.id) ?? [];
      const validation = validateTabularReview({
        review,
        cells: reviewCells,
        documentById: documentById as Map<string, Record<string, unknown>>,
        matterId: input.snapshot.task.matter_id,
        userId: input.userId,
      });
      if (validation.status === "invalid") {
        deliverables.push({
          key: item.key,
          artifact_type: artifactType,
          artifact_id: item.artifact.artifact_id,
          document_id: null,
          current_version_id: null,
          accepted_view_sha256: null,
          accepted_view_text: null,
          accepted_view_complete: false,
        });
        checks.push(
          gapCheck(
            `tabular-review-integrity:${item.key}`,
            "artifact_integrity",
            `${item.key} does not match the fixed Matter-owned document-row Tabular Review contract.`,
            {
              code: "tabular_review_invalid",
              deliverable_key: item.key,
              review_id: review.id,
              reason: validation.reason,
              total_cells: validation.totalCells,
            },
          ),
        );
        continue;
      }
      let boundReview = review;
      let boundCells = reviewCells;
      let boundValidation = validation;
      let litigationBinding =
        litigationReceipt.success && litigationCompletion.success
          ? readCurrentLitigationEvidenceInventoryBinding({
              snapshot: input.snapshot,
              receipt: litigationReceipt.data,
              completion: litigationCompletion.data,
              review,
              cells: reviewCells,
            })
          : null;
      let inputDigest = committedTabularInputDigest(
        input.snapshot,
        review.id,
        litigationBinding,
      );
      const inputDigestBefore = inputDigest;
      let revisionBefore: TabularRevisionIdentity | null = null;
      let revisionUnstableReason:
        | "input_digest_unavailable"
        | "input_digest_changed"
        | "before_unavailable"
        | null = inputDigest ? null : "input_digest_unavailable";
      if (inputDigest) {
        revisionBefore = await (input.readTabularRevisionIdentity
          ? input.readTabularRevisionIdentity({
              taskId: input.snapshot.task.id,
              userId: input.userId,
              reviewId: review.id,
              inputDigest,
            })
          : readCurrentTabularRevisionIdentity({
              db: input.db,
              taskId: input.snapshot.task.id,
              userId: input.userId,
              reviewId: review.id,
              inputDigest,
            }));
        const current = await readCurrentTabularReviewState({
          db: input.db,
          reviewId: review.id,
        });
        if (!current.review) {
          deliverables.push({
            key: item.key,
            artifact_type: artifactType,
            artifact_id: item.artifact.artifact_id,
            document_id: null,
            current_version_id: null,
            accepted_view_sha256: null,
            accepted_view_text: null,
            accepted_view_complete: false,
          });
          checks.push(
            gapCheck(
              `artifact-available:${item.key}`,
              "artifact_integrity",
              `${item.key} no longer resolves to an available Tabular Review.`,
              {
                code: "artifact_unavailable",
                deliverable_key: item.key,
                artifact_id: item.artifact.artifact_id,
              },
            ),
          );
          continue;
        }
        boundReview = current.review;
        boundCells = current.cells;
        const refreshedValidation = validateTabularReview({
          review: boundReview,
          cells: boundCells,
          documentById: documentById as Map<string, Record<string, unknown>>,
          matterId: input.snapshot.task.matter_id,
          userId: input.userId,
        });
        if (
          boundReview.project_id !== input.snapshot.task.matter_id ||
          boundReview.user_id !== input.userId ||
          refreshedValidation.status === "invalid"
        ) {
          deliverables.push({
            key: item.key,
            artifact_type: artifactType,
            artifact_id: item.artifact.artifact_id,
            document_id: null,
            current_version_id: null,
            accepted_view_sha256: null,
            accepted_view_text: null,
            accepted_view_complete: false,
          });
          checks.push(
            gapCheck(
              `tabular-review-integrity:${item.key}`,
              "artifact_integrity",
              `${item.key} changed while the server was binding its current accepted view.`,
              {
                code: "tabular_review_invalid",
                deliverable_key: item.key,
                review_id: boundReview.id,
                reason:
                  refreshedValidation.status === "invalid"
                    ? refreshedValidation.reason
                    : "source_scope",
                total_cells:
                  refreshedValidation.status === "invalid"
                    ? refreshedValidation.totalCells
                    : boundCells.length,
              },
            ),
          );
          continue;
        }
        boundValidation = refreshedValidation;
        litigationBinding =
          litigationReceipt.success && litigationCompletion.success
            ? readCurrentLitigationEvidenceInventoryBinding({
                snapshot: input.snapshot,
                receipt: litigationReceipt.data,
                completion: litigationCompletion.data,
                review: boundReview,
                cells: boundCells,
              })
            : null;
        inputDigest = committedTabularInputDigest(
          input.snapshot,
          boundReview.id,
          litigationBinding,
        );
        if (
          inputDigest !== inputDigestBefore ||
          ((litigationReceipt.success || litigationCompletion.success) &&
            litigationBinding?.status !== "valid")
        ) {
          // A source-bound correction may have changed the attempt while the
          // view was being read. Do not combine the before revision with the
          // later effect; deterministic review routing preserves this view.
          revisionBefore = null;
          revisionUnstableReason = "input_digest_changed";
        }
      }
      let incompleteCells = boundValidation.incompleteCells;
      if (litigationBinding?.status === "valid") {
        incompleteCells = 0;
      }
      let accepted: ReturnType<typeof buildAgentTabularAcceptedView> | null =
        null;
      if (inputDigest) {
        try {
          accepted = buildAgentTabularAcceptedView({
            review: boundReview,
            input_digest: inputDigest,
            document_ids: boundValidation.documentIds,
            column_indexes: boundValidation.columnIndexes,
            cells: Array.from(boundValidation.cellsByCoordinate.values()).map(
              (cell) => ({
                ...cell,
                document_id: cell.document_id!,
                column_index: cell.column_index!,
              }),
            ),
          });
        } catch (error) {
          const fallbackAcceptedView = tabularReviewAcceptedView({
            review: boundReview,
            documentIds: boundValidation.documentIds,
            columnIndexes: boundValidation.columnIndexes,
            cellsByCoordinate: boundValidation.cellsByCoordinate,
          });
          deliverables.push({
            key: item.key,
            artifact_type: artifactType,
            artifact_id: item.artifact.artifact_id,
            document_id: null,
            current_version_id: null,
            accepted_view_sha256: null,
            accepted_view_text: null,
            accepted_view_complete: false,
          });
          if (
            isAgentTabularAcceptedViewBuildError(error) &&
            error.code === "cell_scope_exceeded"
          ) {
            checks.push(
              gapCheck(
                `verification-scope:${item.key}`,
                "goal_coverage",
                `${item.key} exceeds the fixed complete Tabular accepted-view scope and requires lawyer review.`,
                {
                  code: "verification_scope_exceeded",
                  deliverable_key: item.key,
                  accepted_view_characters: fallbackAcceptedView.length,
                  projected_characters: 0,
                },
              ),
            );
          } else {
            checks.push(
              gapCheck(
                `tabular-review-integrity:${item.key}`,
                "artifact_integrity",
                `${item.key} has an invalid current Tabular accepted view.`,
                {
                  code: "tabular_review_invalid",
                  deliverable_key: item.key,
                  review_id: boundReview.id,
                  reason: "layout",
                  total_cells: boundCells.length,
                },
              ),
            );
          }
          continue;
        }
      }
      const acceptedView =
        accepted?.accepted_view_text ??
        tabularReviewAcceptedView({
          review: boundReview,
          documentIds: boundValidation.documentIds,
          columnIndexes: boundValidation.columnIndexes,
          cellsByCoordinate: boundValidation.cellsByCoordinate,
        });
      const projection = projectAcceptedView({
        acceptedView,
        remainingCharacters: remainingProjectionCharacters,
      });
      remainingProjectionCharacters = Math.max(
        0,
        remainingProjectionCharacters - projection.projectedCharacters,
      );
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256:
          accepted?.accepted_view_sha256 ?? acceptedViewSha256(acceptedView),
        accepted_view_text: projection.projection,
        accepted_view_complete: projection.projectionComplete,
      });
      checks.push(
        passCheck(
          `current-artifact:${item.key}`,
          "artifact_integrity",
          `${item.key} is the readable current document-row Tabular Review in the fixed Matter.`,
        ),
      );
      if (incompleteCells > 0) {
        checks.push(
          gapCheck(
            `tabular-review-complete:${item.key}`,
            "workflow_completion",
            `${item.key} has ${incompleteCells} incomplete cell(s); completed cells were preserved for lawyer review.`,
            {
              code: "tabular_review_incomplete",
              deliverable_key: item.key,
              review_id: boundReview.id,
              total_cells: boundValidation.totalCells,
              incomplete_cells: incompleteCells,
            },
          ),
        );
      } else {
        checks.push(
          passCheck(
            `tabular-review-complete:${item.key}`,
            "workflow_completion",
            `${item.key} has a completed value for every fixed document-row cell.`,
          ),
        );
      }
      if (!projection.projectionComplete) {
        checks.push(
          gapCheck(
            `verification-scope:${item.key}`,
            "goal_coverage",
            `${item.key} exceeds the bounded semantic verification projection and requires lawyer review of the complete current Tabular Review.`,
            {
              code: "verification_scope_exceeded",
              deliverable_key: item.key,
              accepted_view_characters: acceptedView.length,
              projected_characters: projection.projectedCharacters,
            },
          ),
        );
      }
      if (accepted && inputDigest && revisionBefore) {
        const revisionAfter = await (input.readTabularRevisionIdentity
          ? input.readTabularRevisionIdentity({
              taskId: input.snapshot.task.id,
              userId: input.userId,
              reviewId: boundReview.id,
              inputDigest,
            })
          : readCurrentTabularRevisionIdentity({
              db: input.db,
              taskId: input.snapshot.task.id,
              userId: input.userId,
              reviewId: boundReview.id,
              inputDigest,
            }));
        if (
          revisionAfter &&
          revisionAfter.revision_fingerprint ===
            revisionBefore.revision_fingerprint
        ) {
          const identity = verifiedTabularArtifactIdentitySchema.parse({
            kind: "agent_verified_tabular_artifact_v1",
            review_id: boundReview.id,
            row_protocol: "document_rows",
            input_digest: inputDigest,
            revision_fingerprint: revisionAfter.revision_fingerprint,
            accepted_view_sha256: accepted.accepted_view_sha256,
            source_receipt_fingerprint:
              litigationBinding?.status === "valid"
                ? litigationBinding.binding.completion.source_receipt_fingerprint
                : null,
            decision_fingerprint:
              litigationBinding?.status === "valid"
                ? litigationBinding.binding.completion.decision_fingerprint
                : null,
            completion_sha256:
              litigationBinding?.status === "valid"
                ? sha256AgentArtifact(litigationBinding.binding.completion)
                : null,
          });
          verifiedArtifacts.push(
            litigationBinding?.status === "valid"
              ? assertLitigationVerifiedTabularArtifact(identity)
              : identity,
          );
        } else {
          checks.push(
            tabularRevisionUnstableGap({
              key: item.key,
              reviewId: boundReview.id,
              totalCells: boundValidation.totalCells,
              reason: revisionAfter ? "changed" : "after_unavailable",
            }),
          );
        }
      } else if (accepted) {
        checks.push(
          tabularRevisionUnstableGap({
            key: item.key,
            reviewId: boundReview.id,
            totalCells: boundValidation.totalCells,
            reason: revisionUnstableReason ?? "before_unavailable",
          }),
        );
      } else {
        checks.push(
          tabularRevisionUnstableGap({
            key: item.key,
            reviewId: boundReview.id,
            totalCells: boundValidation.totalCells,
            reason: revisionUnstableReason ?? "input_digest_unavailable",
          }),
        );
      }
      continue;
    }
    const document = documentById.get(item.artifact.artifact_id);
    if (!document) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-available:${item.key}`,
          "artifact_integrity",
          `${item.key} does not resolve to an available Document.`,
          {
            code: "artifact_unavailable",
            deliverable_key: item.key,
            artifact_id: item.artifact.artifact_id,
          },
        ),
      );
      continue;
    }
    if (
      document.user_id !== input.userId ||
      document.project_id !== input.snapshot.task.matter_id
    ) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-matter:${item.key}`,
          "artifact_integrity",
          `${item.key} is outside the fixed Matter.`,
          {
            code: "artifact_outside_matter",
            deliverable_key: item.key,
            artifact_id: item.artifact.artifact_id,
          },
        ),
      );
      continue;
    }
    const currentVersionId =
      typeof document.current_version_id === "string"
        ? document.current_version_id
        : null;
    const expectedVersionId =
      expectedVersionByDocument.get(document.id as string) ?? currentVersionId;
    if (expectedVersionId && currentVersionId !== expectedVersionId) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: document.id as string,
        current_version_id: currentVersionId,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-version:${item.key}`,
          "artifact_integrity",
          `${item.key} no longer points to its fixed generated Version.`,
          {
            code: "artifact_version_changed",
            deliverable_key: item.key,
            document_id: document.id as string,
            expected_version_id: expectedVersionId,
            current_version_id: currentVersionId,
          },
        ),
      );
      continue;
    }
    const version = currentVersionId ? versionById.get(currentVersionId) : null;
    let acceptedView: string | null = null;
    if (version && version.document_id === document.id && !version.deleted_at) {
      try {
        acceptedView = await (input.loadAcceptedView ?? extractAcceptedView)(
          version,
        );
      } catch {
        acceptedView = null;
      }
    }
    if (!currentVersionId || !version || acceptedView === null) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `accepted-view:${item.key}`,
          "artifact_integrity",
          `${item.key} current accepted view could not be read.`,
          currentVersionId
            ? {
                code: "accepted_view_unreadable",
                deliverable_key: item.key,
                document_id: document.id as string,
                version_id: currentVersionId,
              }
            : {
                code: "artifact_unavailable",
                deliverable_key: item.key,
                artifact_id: item.artifact.artifact_id,
              },
        ),
      );
      continue;
    }
    const projectedCharacters = Math.min(
      acceptedView.length,
      MAX_VERIFIER_DELIVERABLE_PROJECTION_CHARS,
      remainingProjectionCharacters,
    );
    const projectionComplete = projectedCharacters === acceptedView.length;
    const acceptedViewProjection = projectionComplete
      ? acceptedView
      : projectedCharacters === 0
        ? null
        : [
            acceptedView.slice(0, Math.floor(projectedCharacters / 2)),
            "\n[INCOMPLETE VERIFICATION PROJECTION — MIDDLE OMITTED]\n",
            acceptedView.slice(
              acceptedView.length - Math.ceil(projectedCharacters / 2),
            ),
          ].join("");
    remainingProjectionCharacters = Math.max(
      0,
      remainingProjectionCharacters - projectedCharacters,
    );
    deliverables.push({
      key: item.key,
      artifact_type: artifactType,
      artifact_id: item.artifact.artifact_id,
      document_id: document.id as string,
      current_version_id: currentVersionId,
      accepted_view_sha256: acceptedViewSha256(acceptedView),
      accepted_view_text: acceptedViewProjection,
      accepted_view_complete: projectionComplete,
    });
    verifiedArtifacts.push(
      verifiedArtifactIdentitySchema.parse({
        kind: "agent_verified_draft_artifact_v1",
        document_id: document.id as string,
        version_id: currentVersionId,
        accepted_view_sha256: acceptedViewSha256(acceptedView),
      }),
    );
    checks.push(
      passCheck(
        `current-artifact:${item.key}`,
        "artifact_integrity",
        `${item.key} is the readable current Version in the fixed Matter.`,
      ),
    );
    const incompleteEnding = detectArtifactIncompleteEnding(acceptedView);
    if (incompleteEnding) {
      checks.push(
        gapCheck(
          `artifact-ending:${item.key}`,
          "artifact_integrity",
          `${item.key} ends at an explicit continuation marker without completing the final sentence.`,
          {
            code: "artifact_incomplete_ending",
            deliverable_key: item.key,
            document_id: document.id as string,
            version_id: currentVersionId,
            accepted_view_sha256: acceptedViewSha256(acceptedView),
            ending_excerpt: incompleteEnding,
          },
        ),
      );
    } else {
      checks.push(
        passCheck(
          `artifact-ending:${item.key}`,
          "artifact_integrity",
          `${item.key} has no high-confidence abrupt final-sentence ending.`,
        ),
      );
    }
    if (!projectionComplete) {
      checks.push(
        gapCheck(
          `verification-scope:${item.key}`,
          "goal_coverage",
          `${item.key} exceeds the bounded semantic verification projection and requires lawyer review of the complete current Version.`,
          {
            code: "verification_scope_exceeded",
            deliverable_key: item.key,
            accepted_view_characters: acceptedView.length,
            projected_characters: projectedCharacters,
          },
        ),
      );
    }
  }

  const incomplete = input.snapshot.task.current_plan
    .slice(0, -1)
    .flatMap((step, position) =>
      step.status === "completed" ? [] : [position],
    );
  checks.push(
    incomplete.length
      ? gapCheck(
          "prior-steps-complete",
          "workflow_completion",
          "One or more prior Steps are incomplete.",
          { code: "prior_step_incomplete", step_positions: incomplete },
        )
      : passCheck(
          "prior-steps-complete",
          "workflow_completion",
          "Every prior Step is complete.",
        ),
  );

  if (input.citationsRequired) {
    if (input.citationCoverage.total === 0) {
      checks.push(
        gapCheck(
          "citation-relocation",
          "source_support",
          "No current citation snapshot is available for relocation.",
          { code: "citation_snapshot_missing", deliverable_key: null },
        ),
      );
    } else if (input.citationCoverage.missing > 0) {
      checks.push(
        gapCheck(
          "citation-relocation",
          "source_support",
          `${input.citationCoverage.missing} citation locator(s) are not exact on their pinned current source Version.`,
          {
            code: "citation_relocation_gap",
            deliverable_key: null,
            total: input.citationCoverage.total,
            missing: input.citationCoverage.missing,
            statuses: Array.from(
              { length: input.citationCoverage.missing },
              () => "missing" as const,
            ),
          },
        ),
      );
    } else {
      checks.push(
        passCheck(
          "citation-relocation",
          "source_support",
          "Every current citation relocates exactly on its pinned source Version.",
        ),
      );
    }
  }

  checks.push(
    ...buildAgentPackDeterministicChecks({
      profile: input.profile,
      currentPlan: input.snapshot.task.current_plan,
      checkpoint: input.snapshot.task.latest_checkpoint,
      deliverables,
    }),
  );

  const context = readFixedMatterContext(input.snapshot.task);
  const packet = buildAgentVerificationPacketV1({
    kind: "agent_verification_packet_v1",
    version: 1,
    task_id: input.snapshot.task.id,
    step_id: input.stepId,
    step_attempt: input.stepAttempt,
    matter_id: input.snapshot.task.matter_id,
    goal: input.snapshot.task.goal,
    profile: input.profile,
    deliverables,
    source_versions: (context?.sources ?? []).map((source) => ({
      document_id: source.document_id,
      version_id: source.version_id,
      role: source.role,
    })),
    deterministic_checks: checks,
  });
  return { packet, verifiedArtifacts };
}
