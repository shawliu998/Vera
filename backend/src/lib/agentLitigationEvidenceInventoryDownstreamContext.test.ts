import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentStepTabularEffectReservation } from "./agent-kernel/effects/tabularEffect";
import { buildMatterContextManifest } from "./agent-kernel/context/matterContext";
import { buildGeneratedLitigationEvidenceCellContent } from "./agent-packs/litigation/litigationEvidenceInventoryCellContent";
import { compileLitigationEvidenceInventoryContext } from "./agent-packs/litigation/litigationEvidenceInventoryContext";
import {
  compileLitigationEvidenceInventoryReceipt,
  litigationEvidenceCellCandidateSchema,
} from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import { compileLitigationEvidenceReviewCompletionReceipt } from "./agent-packs/litigation/litigationEvidenceInventoryReview";
import {
  buildLitigationEvidenceEffectLayout,
  buildLitigationEvidenceReviewSpec,
} from "./agentLitigationEvidenceInventoryExecutor";
import {
  buildLitigationEvidenceInventoryDownstreamContext,
  LitigationEvidenceInventoryDownstreamContextError,
  MAX_LITIGATION_EVIDENCE_DOWNSTREAM_CONTEXT_CHARS,
} from "./agentLitigationEvidenceInventoryDownstreamContext";

const ids = {
  task: "11111111-1111-4111-8111-111111111111",
  matter: "22222222-2222-4222-8222-222222222222",
  createStep: "33333333-3333-4333-8333-333333333333",
  analyzeStep: "44444444-4444-4444-8444-444444444444",
  draftStepOne: "55555555-5555-4555-8555-555555555555",
  draftStepTwo: "66666666-6666-4666-8666-666666666666",
  source: "77777777-7777-4777-8777-777777777777",
  version: "88888888-8888-4888-8888-888888888888",
};

const quote = "Bluewater delivered the pumps on 3 March 2026.";

function sourceValue(value: string | null, citationId: string) {
  return {
    value,
    citation_ids: value === null ? [] : [citationId],
  };
}

function storedCell(input: {
  receipt: ReturnType<typeof compileLitigationEvidenceInventoryReceipt>;
  index: number;
  reviewStatus: "verified" | "unresolved";
}) {
  const fixed = input.receipt.cells[input.index]!;
  const citation = {
    citation_id: `citation-${String(input.index).padStart(24, "0")}`,
    source_type: "record_evidence" as const,
    document_id: fixed.document_id,
    version_id: fixed.version_id,
    locator: { kind: "page" as const, value: "1" },
    quote,
  };
  const values =
    fixed.field === "relevance"
      ? {
          source_stated_fact: sourceValue("Delivery", citation.citation_id),
          source_to_fact_connection: sourceValue(
            "The record describes the delivery event.",
            citation.citation_id,
          ),
          dispute_status: "unknown" as const,
        }
      : fixed.field === "purpose_of_proof"
        ? {
            potential_purpose: sourceValue(
              "Potential proof of delivery.",
              citation.citation_id,
            ),
            proposition_scope: "document_records_assertion" as const,
          }
        : fixed.field === "authenticity"
          ? {
              origin: sourceValue("Record origin", citation.citation_id),
              signature_or_seal: sourceValue(null, citation.citation_id),
              chain_of_custody: sourceValue(null, citation.citation_id),
              express_authenticity_challenge: sourceValue(
                null,
                citation.citation_id,
              ),
            }
          : fixed.field === "admissibility"
            ? {
                form: sourceValue("Document", citation.citation_id),
                acquisition_method: sourceValue(null, citation.citation_id),
                express_objection: sourceValue(null, citation.citation_id),
              }
            : {
                name_or_title: sourceValue(
                  "Delivery record",
                  citation.citation_id,
                ),
                document_type: sourceValue(null, citation.citation_id),
                date: sourceValue(null, citation.citation_id),
                author_issuer_sender: sourceValue(null, citation.citation_id),
                recipient_counterparty: sourceValue(null, citation.citation_id),
                offering_party: sourceValue(null, citation.citation_id),
              };
  const candidate = litigationEvidenceCellCandidateSchema.parse({
    kind: "litigation_evidence_cell_candidate_v1",
    cell_id: fixed.cell_id,
    document_id: fixed.document_id,
    version_id: fixed.version_id,
    result: { field: fixed.field, values },
    reasoning:
      "The source records a delivery assertion without adding a legal conclusion.",
    reasoning_citation_ids: [citation.citation_id],
    citations: [citation],
    lawyer_review_status: "unverified",
  });
  const content = buildGeneratedLitigationEvidenceCellContent(candidate);
  return {
    id: fixed.cell_id,
    review_id: input.receipt.review_id,
    document_id: fixed.document_id,
    row_id: null,
    column_index: fixed.field_index,
    status: "done" as const,
    content: JSON.stringify(content),
    citations: candidate.citations,
    review_status: input.reviewStatus,
    reviewed_at: "2026-08-08T12:00:00.000Z",
    review_revision: 1,
  };
}

function fakeDb(input: {
  review: Record<string, unknown>;
  cells: Array<Record<string, unknown>>;
  currentVersionId?: string;
}) {
  return {
    from(table: string) {
      const rows =
        table === "tabular_reviews"
          ? [input.review]
          : table === "tabular_cells"
            ? input.cells
            : table === "documents"
              ? [
                  {
                    id: ids.source,
                    project_id: ids.matter,
                    user_id: "user-1",
                    current_version_id: input.currentVersionId ?? ids.version,
                  },
                ]
              : [];
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              const selected = rows.filter((row) => row[column] === value);
              return {
                maybeSingle: async () => ({
                  data: selected[0] ?? null,
                  error: null,
                }),
                limit: async (limit: number) => ({
                  data: selected.slice(0, limit),
                  error: null,
                }),
              };
            },
            in(column: string, values: unknown[]) {
              return Promise.resolve({
                data: rows.filter((row) => values.includes(row[column])),
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

function fixture(input?: {
  currentStepIndex?: number;
  currentAttempt?: number;
  tamperEffectFingerprint?: boolean;
  tamperReviewLayout?: boolean;
  sourceCurrentVersionId?: string;
  pendingUnresolved?: boolean;
}) {
  const matter = buildMatterContextManifest({
    matterId: ids.matter,
    compiledAt: "2026-08-08T10:00:00.000Z",
    workflow: {
      id: "builtin-litigation-hearing-preparation",
      title: "Hearing preparation",
      description: "Prepare evidence and hearing work product.",
      type: "assistant",
      instructions: "Use the fixed Matter record.",
      columns: [],
    },
    sources: [
      {
        document_id: ids.source,
        version_id: ids.version,
        filename: "Bluewater delivery record.docx",
        file_type: "docx",
        role: "source",
      },
    ],
  });
  const context = compileLitigationEvidenceInventoryContext({
    matter,
    packInput: {
      procedural_stage: "first_instance",
      represented_side: "claimant_plaintiff",
      output_language: "en",
    },
  });
  const receipt = compileLitigationEvidenceInventoryReceipt({
    taskId: ids.task,
    matterId: ids.matter,
    stepId: ids.createStep,
    attempt: 1,
    proceduralStage: "first_instance",
    representedSide: "claimant_plaintiff",
    sourcePins: [{ document_id: ids.source, version_id: ids.version }],
  });
  const cells = receipt.cells.map((_, index) =>
    storedCell({ receipt, index, reviewStatus: "verified" }),
  );
  if (input?.pendingUnresolved) {
    cells[2] = {
      ...cells[2]!,
      status: "pending",
      content: null,
      citations: null,
      review_status: "unresolved",
    };
  } else {
    cells[2] = { ...cells[2]!, review_status: "unresolved" };
  }
  const completion = compileLitigationEvidenceReviewCompletionReceipt({
    receipt,
    cells,
    completedAt: "2026-08-08T12:10:00.000Z",
  });
  const spec = buildLitigationEvidenceReviewSpec(receipt);
  const reservation = buildAgentStepTabularEffectReservation({
    stepId: ids.createStep,
    attempt: 1,
    reviewId: receipt.review_id,
    layout: buildLitigationEvidenceEffectLayout(spec),
    createdAt: "2026-08-08T12:01:00.000Z",
  });
  const committed = {
    ...reservation,
    input_fingerprint: input?.tamperEffectFingerprint
      ? "0".repeat(64)
      : reservation.input_fingerprint,
    status: "committed" as const,
    effect: {
      review_id: receipt.review_id,
      artifact_type: "tabular_review" as const,
    },
    committed_at: "2026-08-08T12:02:00.000Z",
  };
  const currentStepIndex = input?.currentStepIndex ?? 1;
  const planIds = [
    ids.createStep,
    ids.analyzeStep,
    ids.draftStepOne,
    ids.draftStepTwo,
  ];
  const snapshot = {
    task: {
      id: ids.task,
      matter_id: ids.matter,
      deliverables: [
        {
          key: "evidence-inventory",
          artifact_type: "tabular_review",
          purpose: "Evidence inventory",
          required: true,
        },
      ],
      latest_checkpoint: {
        litigation_evidence_inventory_context: context,
        litigation_evidence_inventory_receipt: receipt,
        litigation_evidence_review_completion: completion,
      },
      current_plan: planIds.map((id, index) => ({
        id,
        status:
          index < currentStepIndex
            ? "completed"
            : index === currentStepIndex
              ? "running"
              : "pending",
        attempt:
          index === 0
            ? (input?.currentAttempt ?? 1)
            : index === currentStepIndex
              ? 1
              : 0,
        result_data:
          index === 0
            ? { tabular_effect_receipts: { [committed.effect_key]: committed } }
            : undefined,
      })),
    },
    artifacts: [
      {
        artifact_type: "tabular_review" as const,
        artifact_id: receipt.review_id,
        purpose: "Evidence inventory",
      },
    ],
  };
  const review = {
    ...spec,
    user_id: "user-1",
    columns_config: input?.tamperReviewLayout
      ? [{ ...spec.columns_config[0], name: "tampered" }]
      : spec.columns_config,
  };
  return {
    matter,
    receipt,
    cells,
    snapshot,
    db: fakeDb({
      review,
      cells,
      currentVersionId: input?.sourceCurrentVersionId,
    }),
  };
}

function loadExactSource() {
  return async () => ({
    source: { text: `[Page 1]\n${quote}`, pdf: true, spreadsheet: null },
    currentVersionId: ids.version,
  });
}

test("injects the accepted Evidence Inventory into later analysis and Word-create Steps", async () => {
  for (const step of [
    [1, "analysis"],
    [2, "first Word create"],
    [3, "second Word create"],
  ] as const) {
    const run = fixture({ currentStepIndex: step[0], pendingUnresolved: true });
    const context = await buildLitigationEvidenceInventoryDownstreamContext({
      db: run.db as never,
      snapshot: run.snapshot,
      userId: "user-1",
      matter: run.matter,
      currentStepIndex: step[0],
      currentStepIsVerifier: false,
      loadSource: loadExactSource(),
    });
    assert.match(context ?? "", /UNTRUSTED EVIDENCE DATA/);
    assert.match(context ?? "", /"lawyer_review_status":"unresolved"/);
    assert.match(context ?? "", /"source_bound_gap":true/);
    assert.match(context ?? "", /Bluewater delivered the pumps/);
    assert.notEqual(context, null, step[1]);
  }
});

test("does not inject a Review UUID alone, before publication, or into a verifier", async () => {
  const uuidOnly = fixture();
  uuidOnly.snapshot.task.latest_checkpoint = {
    litigation_evidence_inventory_context:
      uuidOnly.snapshot.task.latest_checkpoint
        .litigation_evidence_inventory_context,
  };
  assert.equal(
    await buildLitigationEvidenceInventoryDownstreamContext({
      db: uuidOnly.db as never,
      snapshot: uuidOnly.snapshot,
      userId: "user-1",
      matter: uuidOnly.matter,
      currentStepIndex: 1,
      currentStepIsVerifier: false,
      loadSource: loadExactSource(),
    }),
    null,
  );
  const beforePublication = fixture({ currentStepIndex: 0 });
  assert.equal(
    await buildLitigationEvidenceInventoryDownstreamContext({
      db: beforePublication.db as never,
      snapshot: beforePublication.snapshot,
      userId: "user-1",
      matter: beforePublication.matter,
      currentStepIndex: 0,
      currentStepIsVerifier: false,
      loadSource: loadExactSource(),
    }),
    null,
  );
  const verifier = fixture();
  assert.equal(
    await buildLitigationEvidenceInventoryDownstreamContext({
      db: verifier.db as never,
      snapshot: verifier.snapshot,
      userId: "user-1",
      matter: verifier.matter,
      currentStepIndex: 1,
      currentStepIsVerifier: true,
      loadSource: loadExactSource(),
    }),
    null,
  );
});

test("fails closed for old attempts, forged effects, layout or completion drift, and current Version drift", async () => {
  const completionDrift = fixture();
  const completionCheckpoint = completionDrift.snapshot.task
    .latest_checkpoint as Record<string, unknown>;
  completionCheckpoint.litigation_evidence_review_completion = {
    ...(completionCheckpoint.litigation_evidence_review_completion as Record<
      string,
      unknown
    >),
    decision_fingerprint: "0".repeat(64),
  };
  const duplicateLink = fixture();
  duplicateLink.snapshot.artifacts.push({
    ...duplicateLink.snapshot.artifacts[0]!,
  });
  const needsCorrection = fixture();
  needsCorrection.cells[0] = {
    ...needsCorrection.cells[0]!,
    review_status: "needs_correction",
  };
  const invalid = [
    fixture({ currentAttempt: 2 }),
    fixture({ tamperEffectFingerprint: true }),
    fixture({ tamperReviewLayout: true }),
    fixture({ sourceCurrentVersionId: "99999999-9999-4999-8999-999999999999" }),
    completionDrift,
    duplicateLink,
    needsCorrection,
  ];
  for (const run of invalid) {
    await assert.rejects(
      buildLitigationEvidenceInventoryDownstreamContext({
        db: run.db as never,
        snapshot: run.snapshot,
        userId: "user-1",
        matter: run.matter,
        currentStepIndex: 1,
        currentStepIsVerifier: false,
        loadSource: loadExactSource(),
      }),
      (error: unknown) =>
        error instanceof LitigationEvidenceInventoryDownstreamContextError,
    );
  }
});

test("does not truncate an oversized accepted view", async () => {
  const run = fixture();
  for (const cell of run.cells) {
    const content = JSON.parse(String(cell.content)) as {
      summary: string;
      reasoning: string;
      candidate: {
        reasoning: string;
        citations: Array<{ citation_id: string }>;
        result: { values: Record<string, unknown> };
      };
    };
    content.summary = "S".repeat(12_000);
    content.reasoning = "R".repeat(4_000);
    content.candidate.reasoning = "R".repeat(4_000);
    for (const value of Object.values(content.candidate.result.values)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const sourced = value as { value?: unknown; citation_ids?: unknown };
      if (!Object.hasOwn(sourced, "value")) continue;
      sourced.value = "V".repeat(4_000);
      sourced.citation_ids = [content.candidate.citations[0]!.citation_id];
    }
    cell.content = JSON.stringify(content);
  }
  const checkpoint = run.snapshot.task.latest_checkpoint as Record<
    string,
    unknown
  >;
  checkpoint.litigation_evidence_review_completion =
    compileLitigationEvidenceReviewCompletionReceipt({
      receipt: run.receipt,
      cells: run.cells as never,
      completedAt: "2026-08-08T12:10:00.000Z",
    });
  await assert.rejects(
    buildLitigationEvidenceInventoryDownstreamContext({
      db: run.db as never,
      snapshot: run.snapshot,
      userId: "user-1",
      matter: run.matter,
      currentStepIndex: 1,
      currentStepIsVerifier: false,
      loadSource: loadExactSource(),
    }),
    (error: unknown) =>
      error instanceof LitigationEvidenceInventoryDownstreamContextError &&
      error.code === "projection_scope_exceeded" &&
      Number(error.facts.accepted_view_characters) >
        MAX_LITIGATION_EVIDENCE_DOWNSTREAM_CONTEXT_CHARS,
  );
});

test("fails closed for a one-sided receipt or completion", async () => {
  const run = fixture();
  const checkpoint = run.snapshot.task.latest_checkpoint as Record<
    string,
    unknown
  >;
  delete checkpoint.litigation_evidence_review_completion;
  await assert.rejects(
    buildLitigationEvidenceInventoryDownstreamContext({
      db: run.db as never,
      snapshot: run.snapshot,
      userId: "user-1",
      matter: run.matter,
      currentStepIndex: 1,
      currentStepIsVerifier: false,
      loadSource: loadExactSource(),
    }),
    (error: unknown) =>
      error instanceof LitigationEvidenceInventoryDownstreamContextError &&
      error.code === "binding_invalid",
  );
});

test("fails closed when a citation quote drifts and leaves other workflows untouched", async () => {
  const run = fixture();
  await assert.rejects(
    buildLitigationEvidenceInventoryDownstreamContext({
      db: run.db as never,
      snapshot: run.snapshot,
      userId: "user-1",
      matter: run.matter,
      currentStepIndex: 1,
      currentStepIsVerifier: false,
      loadSource: async () => ({
        source: {
          text: "Different source text",
          pdf: false,
          spreadsheet: null,
        },
        currentVersionId: ids.version,
      }),
    }),
    (error: unknown) =>
      error instanceof LitigationEvidenceInventoryDownstreamContextError &&
      error.code === "citation_drift",
  );
  const other = fixture();
  assert.equal(
    await buildLitigationEvidenceInventoryDownstreamContext({
      db: other.db as never,
      snapshot: other.snapshot,
      userId: "user-1",
      matter: { ...other.matter, workflow: null },
      currentStepIndex: 1,
      currentStepIsVerifier: false,
      loadSource: loadExactSource(),
    }),
    null,
  );
});
