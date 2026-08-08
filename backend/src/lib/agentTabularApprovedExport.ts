import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import * as XLSX from "xlsx";
import { z } from "zod";

import {
  approvedTabularArtifactSnapshotSchema,
  type ApprovedTabularArtifactSnapshot,
} from "./agentApprovedArtifactSnapshot";
import {
  verifiedTabularArtifactIdentitySchema,
  type VerifiedTabularArtifactIdentity,
} from "./agent-kernel/contracts/verifiedArtifactIdentity";
import { assertLitigationVerifiedTabularArtifact } from "./agent-packs/litigation/litigationEvidenceInventoryVerifiedArtifact";
import { readAgentStepReceipts } from "./agent-kernel/contracts/stepContract";
import {
  buildAgentTabularAcceptedView,
  sha256AgentArtifact,
  type AgentTabularAcceptedViewMaterialization,
} from "./agentTabularAcceptedView";
import {
  litigationEvidenceCitationIsExact,
  loadFixedLitigationEvidenceSource,
} from "./agentLitigationEvidenceInventoryGeneration";
import {
  readCurrentLitigationEvidenceInventoryBinding,
  type LitigationEvidenceInventoryBinding,
} from "./agentLitigationEvidenceInventoryBinding";
import { downloadFile, uploadFileIfAbsent, versionStorageKey } from "./storage";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const APPROVED_TABULAR_EXPORT_GENERATOR_VERSION =
  "litigation-evidence-inventory-xlsx-v1" as const;
export const MAX_APPROVED_TABULAR_CANONICAL_BYTES = 8 * 1024 * 1024;
export const MAX_APPROVED_TABULAR_XLSX_BYTES = 100 * 1024 * 1024;
export const MAX_APPROVED_TABULAR_CELLS = 500;

const FIXED_WORKBOOK_DATE = new Date("2000-01-01T00:00:00.000Z");
const CANONICAL_CELL_CHARS = 30_000;

type ReviewRow = {
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

type SourceVersionLabel = {
  document_id: string;
  version_id: string;
  filename: string;
};

type PublicationStep = {
  id: string;
  position: number;
  status: string;
  attempt: number;
  result_data?: unknown;
};

export type ApprovedTabularExportSnapshotInput = {
  task: {
    id: string;
    matter_id: string;
    status: string;
    latest_checkpoint?: unknown;
  };
};

export type ApprovedTabularExportPlan = {
  export_document_id: string;
  export_version_id: string;
  version_number: number;
  storage_path: string;
  filename: string;
  file_type: "xlsx";
};

const approvedTabularExportPlanResponseSchema = z
  .object({
    outcome: z.literal("prepared"),
    verified_identity: verifiedTabularArtifactIdentitySchema,
    export_document_id: z.string().uuid(),
    export_version_id: z.string().uuid(),
    version_number: z.number().int().min(1),
    storage_path: z.string().min(1),
    filename: z.string().trim().min(1).max(500),
    file_type: z.literal("xlsx"),
  })
  .strict();

export function parseApprovedTabularExportPlan(
  value: unknown,
  expected: {
    userId: string;
    filename: string;
    verifiedIdentity: VerifiedTabularArtifactIdentity;
  },
): ApprovedTabularExportPlan {
  const parsed = approvedTabularExportPlanResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    !isDeepStrictEqual(
      parsed.data.verified_identity,
      expected.verifiedIdentity,
    ) ||
    parsed.data.filename !== expected.filename ||
    parsed.data.storage_path !==
      versionStorageKey(
        expected.userId,
        parsed.data.export_document_id,
        parsed.data.export_version_id,
        parsed.data.filename,
      )
  ) {
    throw new Error("The approved Tabular export plan is malformed");
  }
  return {
    export_document_id: parsed.data.export_document_id,
    export_version_id: parsed.data.export_version_id,
    version_number: parsed.data.version_number,
    storage_path: parsed.data.storage_path,
    filename: parsed.data.filename,
    file_type: parsed.data.file_type,
  };
}

export type ApprovedTabularExportMaterialization = {
  artifact: ApprovedTabularArtifactSnapshot;
  storage_path: string;
};

export type ApprovedTabularExportRepository = {
  load(input: { taskId: string; userId: string; reviewId: string }): Promise<{
    userId: string;
    taskMatterId: string;
    taskStatus: string;
    steps: PublicationStep[];
    review: ReviewRow;
    cells: unknown[];
    sourceVersions: SourceVersionLabel[];
  } | null>;
  prepare(input: {
    taskId: string;
    userId: string;
    reviewId: string;
    purpose: string;
    verifiedIdentity: VerifiedTabularArtifactIdentity;
    filename: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ApprovedTabularExportPlan>;
};

type FixedSource = Awaited<
  ReturnType<typeof loadFixedLitigationEvidenceSource>
>;

export type ApprovedTabularExportDependencies = {
  repository?: ApprovedTabularExportRepository;
  loadSource?: (input: {
    db: Db;
    receipt: LitigationEvidenceInventoryBinding["receipt"];
    documentId: string;
    userId: string;
  }) => Promise<FixedSource>;
  uploadIfAbsent?: typeof uploadFileIfAbsent;
  download?: typeof downloadFile;
};

function sha256Bytes(value: Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeFilename(value: string) {
  const stem =
    value
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "Evidence inventory";
  return `${stem} - Approved.xlsx`;
}

function cellText(
  cell: LitigationEvidenceInventoryBinding["inspection"]["cells"][number],
  binding: LitigationEvidenceInventoryBinding,
  citationReferences: ReadonlyMap<string, number>,
) {
  const disposition =
    cell.review_status === "verified" ? "Verified" : "Unresolved";
  const content = binding.inspection.generatedContent.get(cell.id);
  if (!content) {
    return `Lawyer disposition: ${disposition}\nNo source-bound finding was generated.`;
  }
  const references = [...content.candidate.citations]
    .sort((left, right) => left.citation_id.localeCompare(right.citation_id))
    .map((citation) => {
      const reference = citationReferences.get(citation.citation_id);
      if (!reference) {
        throw new Error(
          "An approved Evidence Inventory citation has no fixed reference",
        );
      }
      return `[${reference}]`;
    })
    .join(" ");
  return [
    `Lawyer disposition: ${disposition}`,
    content.summary,
    `Reasoning: ${content.reasoning}`,
    references ? `Citations: ${references}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function appendCanonicalSheet(workbook: XLSX.WorkBook, value: string) {
  const rows: string[][] = [["Sequence", "Canonical accepted-view JSON"]];
  let offset = 0;
  let sequence = 1;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + CANONICAL_CELL_CHARS);
    if (end < value.length) {
      const code = value.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    rows.push([String(sequence), value.slice(offset, end)]);
    offset = end;
    sequence += 1;
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 10 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(workbook, sheet, "Canonical Data");
}

/**
 * Renders the single server-owned Tabular accepted view. It does not build a
 * second export-specific accepted-view representation.
 */
export function buildApprovedLitigationEvidenceInventoryXlsx(input: {
  reviewTitle: string;
  acceptedView: AgentTabularAcceptedViewMaterialization;
  verifiedIdentity: VerifiedTabularArtifactIdentity;
  binding: LitigationEvidenceInventoryBinding;
  sourceVersions: SourceVersionLabel[];
}) {
  const canonicalBytes = Buffer.byteLength(
    input.acceptedView.accepted_view_text,
    "utf8",
  );
  if (canonicalBytes > MAX_APPROVED_TABULAR_CANONICAL_BYTES) {
    throw new Error(
      "The approved Evidence Inventory exceeds the 8 MiB canonical export boundary",
    );
  }
  const verified = assertLitigationVerifiedTabularArtifact(
    input.verifiedIdentity,
  );
  if (
    verified.review_id !== input.binding.receipt.review_id ||
    verified.accepted_view_sha256 !== input.acceptedView.accepted_view_sha256 ||
    verified.source_receipt_fingerprint !==
      input.binding.completion.source_receipt_fingerprint ||
    verified.decision_fingerprint !==
      input.binding.completion.decision_fingerprint ||
    verified.completion_sha256 !== sha256AgentArtifact(input.binding.completion)
  ) {
    throw new Error(
      "The approved Evidence Inventory no longer matches its verified identity",
    );
  }
  const sourceByDocument = new Map(
    input.sourceVersions.map((source) => [source.document_id, source]),
  );
  for (const pin of input.binding.receipt.source_pins) {
    const source = sourceByDocument.get(pin.document_id);
    if (!source || source.version_id !== pin.version_id) {
      throw new Error("An approved Evidence Inventory source label is missing");
    }
  }

  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: `${input.reviewTitle} — Approved Evidence Inventory`,
    Subject: "Matter-owned approved Evidence Inventory",
    Author: "Vera",
    CreatedDate: FIXED_WORKBOOK_DATE,
    ModifiedDate: FIXED_WORKBOOK_DATE,
  };
  const cellByCoordinate = new Map(
    input.binding.inspection.cells.map((cell) => [
      `${cell.document_id}:${cell.column_index}`,
      cell,
    ]),
  );
  const orderedCitations = input.binding.receipt.cells.flatMap((expected) => {
    const cell = cellByCoordinate.get(
      `${expected.document_id}:${expected.field_index}`,
    );
    const content = cell
      ? input.binding.inspection.generatedContent.get(cell.id)
      : null;
    return [...(content?.candidate.citations ?? [])].sort((left, right) =>
      left.citation_id.localeCompare(right.citation_id),
    );
  });
  const citationReferences = new Map(
    orderedCitations.map((citation, index) => [
      citation.citation_id,
      index + 1,
    ]),
  );
  if (citationReferences.size !== orderedCitations.length) {
    throw new Error(
      "Approved Evidence Inventory citation identities are not unique",
    );
  }
  const reviewRows: string[][] = [
    [
      "Source document",
      ...input.binding.receipt.fields.map((field) => field.title),
    ],
  ];
  for (const pin of input.binding.receipt.source_pins) {
    reviewRows.push([
      sourceByDocument.get(pin.document_id)!.filename,
      ...input.binding.receipt.fields.map((field) =>
        cellText(
          cellByCoordinate.get(`${pin.document_id}:${field.index}`)!,
          input.binding,
          citationReferences,
        ),
      ),
    ]);
  }
  const reviewSheet = XLSX.utils.aoa_to_sheet(reviewRows);
  reviewSheet["!cols"] = [
    { wch: 36 },
    ...input.binding.receipt.fields.map(() => ({ wch: 48 })),
  ];
  reviewSheet["!autofilter"] = {
    ref: `A1:${XLSX.utils.encode_col(input.binding.receipt.fields.length)}${reviewRows.length}`,
  };
  XLSX.utils.book_append_sheet(workbook, reviewSheet, "Review");

  const fieldByIndex = new Map(
    input.binding.receipt.fields.map((field) => [field.index, field]),
  );
  const citationRows: string[][] = [
    [
      "Reference",
      "Source document",
      "Evidence field",
      "Locator type",
      "Locator",
      "Exact quote",
      "Lawyer disposition",
      "Internal citation ID",
      "Internal Source Version",
    ],
  ];
  for (const expected of input.binding.receipt.cells) {
    const cell = cellByCoordinate.get(
      `${expected.document_id}:${expected.field_index}`,
    )!;
    const content = input.binding.inspection.generatedContent.get(cell.id);
    for (const citation of [...(content?.candidate.citations ?? [])].sort(
      (left, right) => left.citation_id.localeCompare(right.citation_id),
    )) {
      citationRows.push([
        `[${citationReferences.get(citation.citation_id)!}]`,
        sourceByDocument.get(expected.document_id)!.filename,
        fieldByIndex.get(expected.field_index)!.title,
        citation.locator.kind,
        citation.locator.value,
        citation.quote,
        cell.review_status === "verified" ? "Verified" : "Unresolved",
        citation.citation_id,
        citation.version_id,
      ]);
    }
  }
  const citationsSheet = XLSX.utils.aoa_to_sheet(citationRows);
  citationsSheet["!cols"] = [
    { wch: 12 },
    { wch: 36 },
    { wch: 24 },
    { wch: 16 },
    { wch: 24 },
    { wch: 80 },
    { wch: 20 },
    { wch: 1, hidden: true },
    { wch: 1, hidden: true },
  ];
  XLSX.utils.book_append_sheet(workbook, citationsSheet, "Citations");

  const receipt = input.binding.receipt;
  const manifestRows: string[][] = [
    ["Field", "Value"],
    ["Generator", APPROVED_TABULAR_EXPORT_GENERATOR_VERSION],
    ["Task", receipt.task_id],
    ["Matter", receipt.matter_id],
    ["Review", receipt.review_id],
    ["Procedural stage", receipt.procedural_stage],
    ["Represented side", receipt.represented_side],
    ["Layout digest", receipt.layout_digest],
    ["Input digest", verified.input_digest],
    ["Revision fingerprint", verified.revision_fingerprint],
    ["Accepted-view SHA-256", verified.accepted_view_sha256],
    ["Source receipt fingerprint", verified.source_receipt_fingerprint],
    ["Decision fingerprint", verified.decision_fingerprint],
    ["Completion SHA-256", verified.completion_sha256],
    ["Verified cells", String(input.binding.completion.verified_cells)],
    ["Unresolved cells", String(input.binding.completion.unresolved_cells)],
  ];
  const manifestSheet = XLSX.utils.aoa_to_sheet(manifestRows);
  manifestSheet["!cols"] = [{ wch: 34 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, manifestSheet, "Manifest");
  appendCanonicalSheet(workbook, input.acceptedView.accepted_view_text);
  workbook.Workbook = {
    ...(workbook.Workbook ?? {}),
    Sheets: workbook.SheetNames.map((name) => ({
      name,
      Hidden: name === "Manifest" || name === "Canonical Data" ? 1 : 0,
    })),
  };

  const bytes = Buffer.from(
    XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
      cellDates: false,
      bookSST: false,
    }),
  );
  if (bytes.byteLength > MAX_APPROVED_TABULAR_XLSX_BYTES) {
    throw new Error("The approved Evidence Inventory XLSX exceeds 100 MiB");
  }
  return {
    bytes,
    sha256: sha256Bytes(bytes),
  };
}

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function createRepository(db: Db): ApprovedTabularExportRepository {
  return {
    async load(input) {
      const { data: task, error: taskError } = await db
        .from("agent_tasks")
        .select("id,user_id,matter_id,status")
        .eq("id", input.taskId)
        .eq("user_id", input.userId)
        .maybeSingle();
      if (taskError) throw new Error(taskError.message);
      if (!task) return null;
      const { data: steps, error: stepsError } = await db
        .from("agent_steps")
        .select("id,status,attempt,result_data,position")
        .eq("task_id", input.taskId)
        .order("position", { ascending: true });
      if (stepsError) throw new Error(stepsError.message);
      const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select(
          "id,project_id,user_id,title,practice,row_protocol,workflow_id,document_ids,columns_config",
        )
        .eq("id", input.reviewId)
        .maybeSingle();
      if (reviewError) throw new Error(reviewError.message);
      if (!review) return null;
      const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select(
          "id,review_id,document_id,row_id,column_index,status,content,citations,review_status,reviewed_at,review_revision",
        )
        .eq("review_id", input.reviewId)
        .limit(MAX_APPROVED_TABULAR_CELLS + 1);
      if (cellsError) throw new Error(cellsError.message);
      if ((cells ?? []).length > MAX_APPROVED_TABULAR_CELLS) {
        throw new Error(
          "The approved Evidence Inventory exceeds 500 fixed cells",
        );
      }
      const pins = Array.isArray((review as ReviewRow).document_ids)
        ? ((review as ReviewRow).document_ids as string[])
        : [];
      const { data: documents, error: documentsError } = pins.length
        ? await db
            .from("documents")
            .select("id,user_id,project_id,current_version_id")
            .in("id", pins)
        : { data: [], error: null };
      if (documentsError) throw new Error(documentsError.message);
      const versionIds = (documents ?? []).flatMap((document) =>
        typeof document.current_version_id === "string"
          ? [document.current_version_id]
          : [],
      );
      const { data: versions, error: versionsError } = versionIds.length
        ? await db
            .from("document_versions")
            .select("id,document_id,filename,deleted_at")
            .in("id", versionIds)
            .is("deleted_at", null)
        : { data: [], error: null };
      if (versionsError) throw new Error(versionsError.message);
      return {
        userId: String(task.user_id),
        taskMatterId: String(task.matter_id),
        taskStatus: String(task.status),
        steps: (steps ?? []) as PublicationStep[],
        review: review as ReviewRow,
        cells: cells ?? [],
        sourceVersions: (versions ?? []).map((version) => ({
          document_id: String(version.document_id),
          version_id: String(version.id),
          filename:
            typeof version.filename === "string" && version.filename.trim()
              ? version.filename.trim()
              : "Matter source",
        })),
      };
    },
    async prepare(input) {
      const { data, error } = await db.rpc(
        "prepare_agent_tabular_export_materialization_v1",
        {
          p_task_id: input.taskId,
          p_user_id: input.userId,
          p_review_id: input.reviewId,
          p_purpose: input.purpose,
          p_verified_identity: input.verifiedIdentity,
          p_filename: input.filename,
          p_size_bytes: input.sizeBytes,
          p_sha256: input.sha256,
        },
      );
      if (error) throw new Error(error.message);
      const row = firstRow(data) as Record<string, unknown> | null;
      if (row?.outcome !== "prepared") {
        throw new Error(
          `The approved Tabular export plan was rejected: ${String(row?.outcome ?? "invalid_input")}`,
        );
      }
      return parseApprovedTabularExportPlan(row, {
        userId: input.userId,
        filename: input.filename,
        verifiedIdentity: input.verifiedIdentity,
      });
    },
  };
}

function verifiedIdentityForReview(input: {
  checkpoint: unknown;
  reviewId: string;
  steps: PublicationStep[];
}) {
  const verifier = [...input.steps].sort(
    (left, right) => right.position - left.position,
  )[0];
  if (!verifier || verifier.status !== "completed") {
    throw new Error(
      "The approved Evidence Inventory has no current completed verifier",
    );
  }
  const matches = readAgentStepReceipts(input.checkpoint).flatMap((receipt) =>
    receipt.capability === "verify" &&
    receipt.outcome === "postconditions_satisfied" &&
    receipt.postconditions.every(
      (postcondition) => postcondition.status === "pass",
    ) &&
    receipt.position === verifier.position &&
    receipt.attempt === verifier.attempt
      ? (receipt.verified_artifacts ?? []).filter(
          (artifact): artifact is VerifiedTabularArtifactIdentity =>
            artifact.kind === "agent_verified_tabular_artifact_v1" &&
            artifact.review_id === input.reviewId,
        )
      : [],
  );
  if (matches.length !== 1) {
    throw new Error(
      "The approved Evidence Inventory requires one fixed verifier identity",
    );
  }
  return assertLitigationVerifiedTabularArtifact(matches[0]!);
}

export async function materializeApprovedLitigationEvidenceInventoryXlsx(input: {
  db: Db;
  snapshot: ApprovedTabularExportSnapshotInput;
  userId: string;
  reviewId: string;
  purpose: string;
  dependencies?: ApprovedTabularExportDependencies;
}): Promise<ApprovedTabularExportMaterialization> {
  const repository =
    input.dependencies?.repository ?? createRepository(input.db);
  const loaded = await repository.load({
    taskId: input.snapshot.task.id,
    userId: input.userId,
    reviewId: input.reviewId,
  });
  if (
    !loaded ||
    loaded.userId !== input.userId ||
    loaded.taskMatterId !== input.snapshot.task.matter_id ||
    loaded.taskStatus !== "completed" ||
    input.snapshot.task.status !== "completed" ||
    loaded.review.id !== input.reviewId ||
    loaded.review.project_id !== loaded.taskMatterId ||
    loaded.review.user_id !== loaded.userId
  ) {
    throw new Error(
      "The approved Evidence Inventory is outside the completed Task Matter",
    );
  }
  const checkpoint =
    input.snapshot.task.latest_checkpoint &&
    typeof input.snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(input.snapshot.task.latest_checkpoint)
      ? (input.snapshot.task.latest_checkpoint as Record<string, unknown>)
      : {};
  const binding = readCurrentLitigationEvidenceInventoryBinding({
    snapshot: {
      task: {
        id: input.snapshot.task.id,
        matter_id: input.snapshot.task.matter_id,
        current_plan: loaded.steps,
      },
    },
    receipt: checkpoint.litigation_evidence_inventory_receipt,
    completion: checkpoint.litigation_evidence_review_completion,
    review: loaded.review,
    cells: loaded.cells,
  });
  if (binding.status !== "valid") {
    throw new Error(
      `The approved Evidence Inventory binding is invalid: ${binding.reason}`,
    );
  }
  const verifiedIdentity = verifiedIdentityForReview({
    checkpoint: input.snapshot.task.latest_checkpoint,
    reviewId: input.reviewId,
    steps: loaded.steps,
  });
  const documentIds = binding.binding.receipt.source_pins.map(
    (pin) => pin.document_id,
  );
  const columnIndexes = binding.binding.receipt.fields.map(
    (field) => field.index,
  );
  const acceptedView = buildAgentTabularAcceptedView({
    review: loaded.review,
    input_digest: verifiedIdentity.input_digest,
    document_ids: documentIds,
    column_indexes: columnIndexes,
    cells: loaded.cells as never[],
  });
  if (
    acceptedView.accepted_view_sha256 !== verifiedIdentity.accepted_view_sha256
  ) {
    throw new Error(
      "The approved Evidence Inventory changed after deterministic verification",
    );
  }
  const loadSource =
    input.dependencies?.loadSource ?? loadFixedLitigationEvidenceSource;
  for (const pin of binding.binding.receipt.source_pins) {
    const source = await loadSource({
      db: input.db,
      receipt: binding.binding.receipt,
      documentId: pin.document_id,
      userId: loaded.userId,
    });
    for (const cell of binding.binding.inspection.cells.filter(
      (candidate) => candidate.document_id === pin.document_id,
    )) {
      const content = binding.binding.inspection.generatedContent.get(cell.id);
      if (
        content?.candidate.citations.some(
          (citation) =>
            !litigationEvidenceCitationIsExact({
              source: source.source,
              quote: citation.quote,
              locator: citation.locator,
              versionId: citation.version_id,
              currentVersionId: source.currentVersionId,
            }),
        )
      ) {
        throw new Error(
          "An approved Evidence Inventory citation no longer relocates exactly",
        );
      }
    }
  }

  const filename = safeFilename(loaded.review.title?.trim() || input.purpose);
  const built = buildApprovedLitigationEvidenceInventoryXlsx({
    reviewTitle: loaded.review.title?.trim() || input.purpose,
    acceptedView,
    verifiedIdentity,
    binding: binding.binding,
    sourceVersions: loaded.sourceVersions,
  });
  const plan = await repository.prepare({
    taskId: input.snapshot.task.id,
    userId: loaded.userId,
    reviewId: input.reviewId,
    purpose: input.purpose,
    verifiedIdentity,
    filename,
    sizeBytes: built.bytes.byteLength,
    sha256: built.sha256,
  });
  const uploadIfAbsent =
    input.dependencies?.uploadIfAbsent ?? uploadFileIfAbsent;
  const download = input.dependencies?.download ?? downloadFile;
  const uploadOutcome = await uploadIfAbsent(
    plan.storage_path,
    built.bytes.buffer.slice(
      built.bytes.byteOffset,
      built.bytes.byteOffset + built.bytes.byteLength,
    ) as ArrayBuffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const stored = await download(plan.storage_path);
  if (!stored) {
    throw new Error("The approved Evidence Inventory bytes are unavailable");
  }
  const storedBytes = Buffer.from(stored);
  if (
    storedBytes.byteLength !== built.bytes.byteLength ||
    sha256Bytes(storedBytes) !== built.sha256
  ) {
    throw new Error(
      uploadOutcome === "exists"
        ? "The prepared approved export path contains different bytes"
        : "The stored approved Evidence Inventory bytes failed verification",
    );
  }
  const artifact = approvedTabularArtifactSnapshotSchema.parse({
    kind: "agent_approved_tabular_artifact_v1",
    artifact_type: "tabular_review",
    artifact_id: input.reviewId,
    purpose: input.purpose,
    review_id: input.reviewId,
    row_protocol: "document_rows",
    input_digest: verifiedIdentity.input_digest,
    revision_fingerprint: verifiedIdentity.revision_fingerprint,
    accepted_view_sha256: verifiedIdentity.accepted_view_sha256,
    source_receipt_fingerprint: verifiedIdentity.source_receipt_fingerprint,
    decision_fingerprint: verifiedIdentity.decision_fingerprint,
    completion_sha256: verifiedIdentity.completion_sha256,
    export_document_id: plan.export_document_id,
    export_version_id: plan.export_version_id,
    version_number: plan.version_number,
    filename: plan.filename,
    file_type: plan.file_type,
    size_bytes: built.bytes.byteLength,
    sha256: built.sha256,
  });
  return { artifact, storage_path: plan.storage_path };
}
