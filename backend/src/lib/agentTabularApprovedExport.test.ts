import assert from "node:assert/strict";
import test from "node:test";

import * as XLSX from "xlsx";

import {
  buildAgentTabularAcceptedView,
  sha256AgentArtifact,
} from "./agentTabularAcceptedView";
import { buildAgentStepReceipt } from "./agent-kernel/contracts/stepContract";
import { buildAgentStepTabularEffectReservation } from "./agent-kernel/effects/tabularEffect";
import { buildGeneratedLitigationEvidenceCellContent } from "./agent-packs/litigation/litigationEvidenceInventoryCellContent";
import {
  compileLitigationEvidenceReviewCompletionReceipt,
  inspectLitigationEvidenceInventoryReview,
  type LitigationEvidenceStoredCellV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryReview";
import {
  compileLitigationEvidenceInventoryReceipt,
  type LitigationEvidenceCellCandidateV1,
  type LitigationEvidenceField,
} from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  buildLitigationEvidenceEffectLayout,
  buildLitigationEvidenceReviewSpec,
} from "./agentLitigationEvidenceInventoryExecutor";
import type { LitigationEvidenceInventoryBinding } from "./agentLitigationEvidenceInventoryBinding";
import {
  buildApprovedLitigationEvidenceInventoryXlsx,
  materializeApprovedLitigationEvidenceInventoryXlsx,
  parseApprovedTabularExportPlan,
  type ApprovedTabularExportRepository,
} from "./agentTabularApprovedExport";

const taskId = "10000000-0000-4000-8000-000000000001";
const matterId = "10000000-0000-4000-8000-000000000002";
const stepId = "10000000-0000-4000-8000-000000000003";
const verifierStepId = "10000000-0000-4000-8000-000000000006";
const reviewDocumentId = "10000000-0000-4000-8000-000000000004";
const sourceVersionId = "10000000-0000-4000-8000-000000000005";
const userId = "test-user";
const reviewedAt = "2026-08-08T08:00:00.000Z";
const revisionFingerprint = "a".repeat(64);

function sourced(value: string | null, citationId: string) {
  return {
    value,
    citation_ids: value === null ? [] : [citationId],
  };
}

function resultFor(field: LitigationEvidenceField, citationId: string) {
  const stated = sourced(`中文结论-${field}`, citationId);
  const unknown = sourced(null, citationId);
  switch (field) {
    case "evidence_item":
      return {
        field,
        values: {
          name_or_title: stated,
          document_type: unknown,
          date: unknown,
          author_issuer_sender: unknown,
          recipient_counterparty: unknown,
          offering_party: unknown,
        },
      } as const;
    case "authenticity":
      return {
        field,
        values: {
          origin: stated,
          signature_or_seal: unknown,
          chain_of_custody: unknown,
          express_authenticity_challenge: unknown,
        },
      } as const;
    case "admissibility":
      return {
        field,
        values: {
          form: stated,
          acquisition_method: unknown,
          express_objection: unknown,
        },
      } as const;
    case "relevance":
      return {
        field,
        values: {
          source_stated_fact: stated,
          source_to_fact_connection: unknown,
          dispute_status: "unknown",
        },
      } as const;
    case "purpose_of_proof":
      return {
        field,
        values: {
          potential_purpose: stated,
          proposition_scope: "document_records_assertion",
        },
      } as const;
  }
}

function fixture() {
  const receipt = compileLitigationEvidenceInventoryReceipt({
    taskId,
    matterId,
    stepId,
    attempt: 1,
    proceduralStage: "first_instance",
    representedSide: "claimant_plaintiff",
    sourcePins: [
      { document_id: reviewDocumentId, version_id: sourceVersionId },
    ],
  });
  const cells: LitigationEvidenceStoredCellV1[] = receipt.cells.map(
    (expected, index) => {
      if (expected.field === "purpose_of_proof") {
        return {
          id: expected.cell_id,
          review_id: receipt.review_id,
          document_id: expected.document_id,
          row_id: null,
          column_index: expected.field_index,
          status: "pending",
          content: null,
          citations: null,
          review_status: "unresolved",
          reviewed_at: reviewedAt,
          review_revision: 1,
        };
      }
      const citationId = `citation-${String(index + 1).padStart(24, "0")}`;
      const quote = `证据原文-${expected.field}`;
      const candidate: LitigationEvidenceCellCandidateV1 = {
        kind: "litigation_evidence_cell_candidate_v1",
        cell_id: expected.cell_id,
        document_id: expected.document_id,
        version_id: expected.version_id,
        result: resultFor(expected.field, citationId),
        reasoning: `仅说明来源与${expected.field}字段的联系。`,
        reasoning_citation_ids: [citationId],
        citations: [
          {
            citation_id: citationId,
            source_type: "record_evidence",
            document_id: expected.document_id,
            version_id: expected.version_id,
            locator: { kind: "paragraph", value: `段落${index + 1}` },
            quote,
          },
        ],
        lawyer_review_status: "unverified",
      };
      const content = buildGeneratedLitigationEvidenceCellContent(candidate);
      return {
        id: expected.cell_id,
        review_id: receipt.review_id,
        document_id: expected.document_id,
        row_id: null,
        column_index: expected.field_index,
        status: "done",
        content: JSON.stringify(content),
        citations: candidate.citations,
        review_status: index % 2 === 0 ? "verified" : "unresolved",
        reviewed_at: reviewedAt,
        review_revision: 1,
      };
    },
  );
  const completion = compileLitigationEvidenceReviewCompletionReceipt({
    receipt,
    cells,
    completedAt: "2026-08-08T08:01:00.000Z",
  });
  const inspection = inspectLitigationEvidenceInventoryReview({
    receipt,
    cells,
  });
  const binding: LitigationEvidenceInventoryBinding = {
    receipt,
    completion,
    inspection,
  };
  const review = {
    ...buildLitigationEvidenceReviewSpec(receipt),
    user_id: userId,
  };
  const reserved = buildAgentStepTabularEffectReservation({
    stepId,
    attempt: 1,
    reviewId: receipt.review_id,
    layout: buildLitigationEvidenceEffectLayout(review),
    createdAt: "2026-08-08T07:00:00.000Z",
  });
  const committed = {
    ...reserved,
    status: "committed" as const,
    effect: {
      review_id: receipt.review_id,
      artifact_type: "tabular_review" as const,
    },
    committed_at: "2026-08-08T07:01:00.000Z",
  };
  const acceptedView = buildAgentTabularAcceptedView({
    review,
    input_digest: reserved.input_fingerprint,
    document_ids: receipt.source_pins.map((pin) => pin.document_id),
    column_indexes: receipt.fields.map((field) => field.index),
    cells: cells.map((cell) => ({
      ...cell,
      citations: cell.citations ?? null,
    })),
  });
  const verifiedIdentity = {
    kind: "agent_verified_tabular_artifact_v1" as const,
    review_id: receipt.review_id,
    row_protocol: "document_rows" as const,
    input_digest: reserved.input_fingerprint,
    revision_fingerprint: revisionFingerprint,
    accepted_view_sha256: acceptedView.accepted_view_sha256,
    source_receipt_fingerprint: completion.source_receipt_fingerprint,
    decision_fingerprint: completion.decision_fingerprint,
    completion_sha256: sha256AgentArtifact(completion),
  };
  const verifierReceipt = buildAgentStepReceipt({
    contract: {
      schema_version: "agent_step_contract_v1",
      position: 1,
      capability: "verify",
      operation: "verify",
      output_expectation: { kind: "verification" },
      source_requirement: {
        mode: "pinned",
        citations_required: true,
        authority_as_of_required: false,
        jurisdictions: [],
        as_of_date: null,
      },
      deterministic_postconditions: ["summary_present", "verifier_passed"],
    },
    attempt: 2,
    summary: "Verified fixed Evidence Inventory.",
    sourceVersionIds: [sourceVersionId],
    artifactIds: [receipt.review_id],
    satisfiedPostconditions: ["summary_present", "verifier_passed"],
    verifiedArtifacts: [verifiedIdentity],
  });
  const snapshot = {
    task: {
      id: taskId,
      user_id: userId,
      matter_id: matterId,
      status: "completed",
      latest_checkpoint: {
        litigation_evidence_inventory_receipt: receipt,
        litigation_evidence_review_completion: completion,
        step_receipts: [{ ...verifierReceipt, attempt: 1 }, verifierReceipt],
      },
    },
  };
  const steps = [
    {
      id: stepId,
      position: 0,
      status: "completed",
      attempt: 1,
      result_data: {
        tabular_effect_receipts: {
          [committed.effect_key]: committed,
        },
      },
    },
    {
      id: verifierStepId,
      position: 1,
      status: "completed",
      attempt: 2,
      result_data: {},
    },
  ];
  return {
    receipt,
    cells,
    completion,
    binding,
    review,
    snapshot,
    steps,
    acceptedView,
    verifiedIdentity,
  };
}

test("builds byte-deterministic approved XLSX with fixed review, citation, manifest and canonical sheets", () => {
  const { binding, acceptedView, verifiedIdentity } = fixture();
  const input = {
    reviewTitle: "蓝水案证据清单",
    binding,
    acceptedView,
    verifiedIdentity,
    sourceVersions: [
      {
        document_id: reviewDocumentId,
        version_id: sourceVersionId,
        filename: "蓝水案证据材料.docx",
      },
    ],
  };
  const first = buildApprovedLitigationEvidenceInventoryXlsx(input);
  const second = buildApprovedLitigationEvidenceInventoryXlsx(input);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  assert.match(acceptedView.accepted_view_sha256, /^sha256:[a-f0-9]{64}$/);

  const workbook = XLSX.read(first.bytes, { type: "buffer", cellStyles: true });
  assert.deepEqual(workbook.SheetNames, [
    "Review",
    "Citations",
    "Manifest",
    "Canonical Data",
  ]);
  const reviewRows = XLSX.utils.sheet_to_json<string[]>(
    workbook.Sheets.Review!,
    { header: 1, raw: false },
  );
  assert.equal(reviewRows[0]![0], "Source document");
  assert.deepEqual(
    reviewRows[0]!.slice(1),
    binding.receipt.fields.map((field) => field.title),
  );
  assert.match(reviewRows[1]![1]!, /Lawyer disposition: Verified/);
  assert.match(reviewRows[1]![1]!, /中文结论-evidence_item/);
  assert.match(reviewRows[1]![5]!, /Lawyer disposition: Unresolved/);

  const citationRows = XLSX.utils.sheet_to_json<string[]>(
    workbook.Sheets.Citations!,
    { header: 1, raw: false },
  );
  assert.equal(citationRows.length, 5);
  assert.equal(citationRows[1]![0], "[1]");
  assert.equal(citationRows[1]![1], "蓝水案证据材料.docx");
  assert.equal(citationRows[1]![2], binding.receipt.fields[0]!.title);
  assert.equal(citationRows[1]![3], "paragraph");
  assert.equal(citationRows[1]![4], "段落1");
  assert.equal(citationRows[1]![5], "证据原文-evidence_item");
  assert.equal(citationRows[1]![6], "Verified");
  assert.match(citationRows[1]![7]!, /^citation-/);
  assert.equal(citationRows[1]![8], sourceVersionId);
  const manifest = XLSX.utils.sheet_to_json<string[]>(
    workbook.Sheets.Manifest!,
    { header: 1, raw: false },
  );
  assert.ok(
    manifest.some(
      (row) => row[0] === "Procedural stage" && row[1] === "first_instance",
    ),
  );
  assert.equal(
    workbook.Workbook?.Sheets?.find((sheet) => sheet.name === "Canonical Data")
      ?.Hidden,
    1,
  );
  assert.equal(
    workbook.Workbook?.Sheets?.find((sheet) => sheet.name === "Manifest")
      ?.Hidden,
    1,
  );
  assert.equal(workbook.Sheets.Citations?.["!cols"]?.[7]?.hidden, true);
  assert.equal(workbook.Sheets.Citations?.["!cols"]?.[8]?.hidden, true);
});

test("rejects malformed or non-canonical DB export plans before storage I/O", () => {
  const { verifiedIdentity } = fixture();
  const filename = "Evidence inventory - Approved.xlsx";
  const exportDocumentId = "20000000-0000-4000-8000-000000000001";
  const exportVersionId = "20000000-0000-4000-8000-000000000002";
  const valid = {
    outcome: "prepared",
    verified_identity: verifiedIdentity,
    export_document_id: exportDocumentId,
    export_version_id: exportVersionId,
    version_number: 1,
    storage_path: `documents/${userId}/${exportDocumentId}/versions/${exportVersionId}.xlsx`,
    filename,
    file_type: "xlsx",
  };
  assert.deepEqual(
    parseApprovedTabularExportPlan(valid, {
      userId,
      filename,
      verifiedIdentity,
    }),
    {
      export_document_id: exportDocumentId,
      export_version_id: exportVersionId,
      version_number: 1,
      storage_path: valid.storage_path,
      filename,
      file_type: "xlsx",
    },
  );
  assert.throws(
    () =>
      parseApprovedTabularExportPlan(
        { ...valid, export_document_id: "not-a-uuid" },
        { userId, filename, verifiedIdentity },
      ),
    /plan is malformed/,
  );
  assert.throws(
    () =>
      parseApprovedTabularExportPlan(
        { ...valid, storage_path: "../../other-user/export.xlsx" },
        { userId, filename, verifiedIdentity },
      ),
    /plan is malformed/,
  );
  assert.throws(
    () =>
      parseApprovedTabularExportPlan(
        {
          ...valid,
          storage_path: `documents/${userId}/${exportDocumentId}/versions/wrong.xlsx`,
        },
        { userId, filename, verifiedIdentity },
      ),
    /plan is malformed/,
  );
});

test("materializes one DB-planned invisible storage object and replays without uploading again", async () => {
  const { receipt, cells, review, snapshot, steps, verifiedIdentity } =
    fixture();
  let prepareCalls = 0;
  const repository: ApprovedTabularExportRepository = {
    async load() {
      return {
        userId,
        taskMatterId: matterId,
        taskStatus: "completed",
        steps,
        review,
        cells,
        sourceVersions: [
          {
            document_id: reviewDocumentId,
            version_id: sourceVersionId,
            filename: "蓝水案证据材料.docx",
          },
        ],
      };
    },
    async prepare(input) {
      prepareCalls += 1;
      assert.deepEqual(input.verifiedIdentity, verifiedIdentity);
      assert.match(input.sha256, /^sha256:[a-f0-9]{64}$/);
      return {
        export_document_id: "20000000-0000-4000-8000-000000000001",
        export_version_id: "20000000-0000-4000-8000-000000000002",
        version_number: 1,
        storage_path:
          "documents/test-user/20000000-0000-4000-8000-000000000001/versions/20000000-0000-4000-8000-000000000002.xlsx",
        filename: input.filename,
        file_type: "xlsx",
      };
    },
  };
  const stored = new Map<string, ArrayBuffer>();
  let uploads = 0;
  const dependencies = {
    repository,
    async loadSource() {
      return {
        source: {
          text: receipt.fields
            .map((field) => `证据原文-${field.id}`)
            .join("\n"),
          spreadsheet: null,
          pdf: false,
        },
        currentVersionId: sourceVersionId,
      };
    },
    async uploadIfAbsent(path: string, bytes: ArrayBuffer) {
      if (stored.has(path)) return "exists" as const;
      uploads += 1;
      stored.set(path, bytes.slice(0));
      return "created" as const;
    },
    async download(path: string) {
      return stored.get(path)?.slice(0) ?? null;
    },
  };
  const first = await materializeApprovedLitigationEvidenceInventoryXlsx({
    db: {} as never,
    snapshot,
    reviewId: receipt.review_id,
    purpose: "Evidence inventory",
    dependencies,
  });
  const second = await materializeApprovedLitigationEvidenceInventoryXlsx({
    db: {} as never,
    snapshot,
    reviewId: receipt.review_id,
    purpose: "Evidence inventory",
    dependencies,
  });
  assert.deepEqual(second, first);
  assert.equal(uploads, 1);
  assert.equal(prepareCalls, 2);
  assert.equal(first.artifact.file_type, "xlsx");
  assert.equal(first.artifact.review_id, receipt.review_id);
  assert.equal(
    first.artifact.export_document_id,
    "20000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    first.artifact.export_version_id,
    "20000000-0000-4000-8000-000000000002",
  );
  assert.match(first.artifact.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    stored.get(first.storage_path)?.byteLength,
    first.artifact.size_bytes,
  );
});

test("rejects a materialization whose authenticated snapshot owner changed", async () => {
  const { receipt, cells, review, snapshot, steps } = fixture();
  const repository: ApprovedTabularExportRepository = {
    async load() {
      return {
        userId,
        taskMatterId: matterId,
        taskStatus: "completed",
        steps,
        review,
        cells,
        sourceVersions: [],
      };
    },
    async prepare() {
      throw new Error("prepare must not run across owners");
    },
  };
  await assert.rejects(
    materializeApprovedLitigationEvidenceInventoryXlsx({
      db: {} as never,
      snapshot: {
        task: { ...snapshot.task, user_id: "different-user" },
      },
      reviewId: receipt.review_id,
      purpose: "Evidence inventory",
      dependencies: { repository },
    }),
    /outside the completed Task Matter/,
  );
});

test("fails closed when deterministic storage already contains different bytes", async () => {
  const { receipt, cells, review, snapshot, steps } = fixture();
  const repository: ApprovedTabularExportRepository = {
    async load() {
      return {
        userId,
        taskMatterId: matterId,
        taskStatus: "completed",
        steps,
        review,
        cells,
        sourceVersions: [
          {
            document_id: reviewDocumentId,
            version_id: sourceVersionId,
            filename: "蓝水案证据材料.docx",
          },
        ],
      };
    },
    async prepare(input) {
      return {
        export_document_id: "20000000-0000-4000-8000-000000000001",
        export_version_id: "20000000-0000-4000-8000-000000000002",
        version_number: 1,
        storage_path: "prepared/export.xlsx",
        filename: input.filename,
        file_type: "xlsx",
      };
    },
  };
  await assert.rejects(
    materializeApprovedLitigationEvidenceInventoryXlsx({
      db: {} as never,
      snapshot,
      reviewId: receipt.review_id,
      purpose: "Evidence inventory",
      dependencies: {
        repository,
        async loadSource() {
          return {
            source: {
              text: receipt.fields
                .map((field) => `证据原文-${field.id}`)
                .join("\n"),
              spreadsheet: null,
              pdf: false,
            },
            currentVersionId: sourceVersionId,
          };
        },
        async uploadIfAbsent() {
          return "exists" as const;
        },
        async download() {
          return Buffer.from("different bytes").buffer;
        },
      },
    }),
    /contains different bytes/,
  );
});
