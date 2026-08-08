import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentStepEffectReservation } from "./agent-kernel/effects/stepEffect";
import {
  AGENT_STEP_TABULAR_EFFECT_RECEIPT_KEY,
  buildAgentStepTabularEffectReservation,
} from "./agent-kernel/effects/tabularEffect";
import { compileLitigationEvidenceInventoryReceipt } from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import { compileLitigationEvidenceReviewCompletionReceipt } from "./agent-packs/litigation/litigationEvidenceInventoryReview";
import {
  buildLitigationEvidenceEffectLayout,
  buildLitigationEvidenceReviewSpec,
} from "./agentLitigationEvidenceInventoryExecutor";
import { buildCurrentAgentVerificationPacket } from "./agentTaskVerificationRepository";

const taskId = "11111111-1111-4111-8111-111111111111";
const matterId = "22222222-2222-4222-8222-222222222222";
const currentVersion = "33333333-3333-4333-8333-333333333333";

function fakeDb(input: {
  documents: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  reviews?:
    | Array<Record<string, unknown>>
    | (() => Array<Record<string, unknown>>);
  cells?:
    | Array<Record<string, unknown>>
    | (() => Array<Record<string, unknown>>);
  cellQueryIds?: string[][];
}) {
  return {
    rpc() {
      return Promise.resolve({
        data: {
          outcome: "current",
          revision_fingerprint: "a".repeat(64),
        },
        error: null,
      });
    },
    from(table: string) {
      const source =
        table === "documents"
          ? input.documents
          : table === "document_versions"
            ? input.versions
            : table === "tabular_reviews"
              ? (input.reviews ?? [])
              : table === "tabular_cells"
                ? (input.cells ?? [])
                : [];
      const rows = typeof source === "function" ? source() : source;
      return {
        select() {
          return {
            in(column: string, ids: string[]) {
              if (table === "tabular_cells") input.cellQueryIds?.push(ids);
              const result = {
                data: rows.filter((row) =>
                  ids.includes(String(row[column] ?? row.id)),
                ),
                error: null,
              };
              return {
                limit: async () => result,
                then: <T>(
                  onfulfilled?:
                    ((value: typeof result) => T | PromiseLike<T>) | null,
                  onrejected?: ((reason: unknown) => T | PromiseLike<T>) | null,
                ) => Promise.resolve(result).then(onfulfilled, onrejected),
              };
            },
          };
        },
      };
    },
  };
}

function fixture() {
  const reserved = buildAgentStepEffectReservation({
    stepId: "step-create",
    attempt: 1,
    toolName: "generate_docx",
    toolInput: { title: "Opinion", sections: [] },
    createdAt: "2026-08-07T00:00:00.000Z",
  });
  const receipt = {
    ...reserved,
    status: "committed" as const,
    effect: {
      document_id: reserved.target.document_id,
      version_id: reserved.target.version_id,
      artifact_type: "draft" as const,
    },
    committed_at: "2026-08-07T00:01:00.000Z",
  };
  return {
    reserved,
    snapshot: {
      task: {
        id: taskId,
        matter_id: matterId,
        goal: "Draft an opinion.",
        deliverables: [
          {
            key: "opinion",
            title: "Opinion",
            required: true,
            artifact_type: "draft",
            purpose: "Opinion",
          },
        ],
        latest_checkpoint: null,
        current_plan: [
          {
            id: "step-create",
            status: "completed",
            attempt: 1,
            result_data: {
              effect_receipts: { [receipt.effect_key]: receipt },
            },
          },
          { id: "step-verify", status: "running", attempt: 1 },
        ],
      },
      artifacts: [
        {
          artifact_type: "draft" as const,
          artifact_id: reserved.target.document_id,
          purpose: "Opinion",
        },
      ],
    },
  };
}

const profile = {
  kind: "agent_verifier_profile_v1" as const,
  id: "generic-current-artifact",
  version: "1",
  semantic_goal_check: true,
  repair_policy: "none" as const,
};

function litigationCompletionFixture(input?: {
  currentAttempt?: number;
  tamperEffectFingerprint?: boolean;
  tamperReceiptLayoutDigest?: boolean;
  completionStepId?: string;
  tamperReviewColumns?: boolean;
  mutateFreshCell?: boolean;
}) {
  const stepId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reviewSourceDocumentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const reviewSourceVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const fixedReceipt = compileLitigationEvidenceInventoryReceipt({
    taskId,
    matterId,
    stepId,
    attempt: 1,
    proceduralStage: "first_instance",
    representedSide: "claimant_plaintiff",
    sourcePins: [
      {
        document_id: reviewSourceDocumentId,
        version_id: reviewSourceVersionId,
      },
    ],
  });
  const receipt = input?.tamperReceiptLayoutDigest
    ? {
        ...fixedReceipt,
        layout_digest: `sha256:${"0".repeat(64)}`,
      }
    : fixedReceipt;
  const spec = buildLitigationEvidenceReviewSpec(fixedReceipt);
  const reservation = buildAgentStepTabularEffectReservation({
    stepId,
    attempt: receipt.attempt,
    reviewId: receipt.review_id,
    layout: buildLitigationEvidenceEffectLayout(spec),
    createdAt: "2026-08-08T12:00:00.000Z",
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
    committed_at: "2026-08-08T12:01:00.000Z",
  };
  const cells = receipt.cells.map((fixed) => ({
    id: fixed.cell_id,
    review_id: receipt.review_id,
    document_id: fixed.document_id,
    row_id: null,
    column_index: fixed.field_index,
    status: "pending" as const,
    content: null,
    citations: null,
    review_status: "unresolved" as const,
    reviewed_at: "2026-08-08T12:02:00.000Z",
    review_revision: 1,
  }));
  const baseCompletion = compileLitigationEvidenceReviewCompletionReceipt({
    receipt,
    cells,
    completedAt: "2026-08-08T12:03:00.000Z",
  });
  const completion = input?.completionStepId
    ? { ...baseCompletion, step_id: input.completionStepId }
    : baseCompletion;
  const review = {
    ...spec,
    user_id: "user-1",
    columns_config: input?.tamperReviewColumns
      ? [{ ...spec.columns_config[0], name: "Tampered axis" }]
      : spec.columns_config,
  };
  let tabularCellReads = 0;
  return {
    db: fakeDb({
      documents: [
        {
          id: reviewSourceDocumentId,
          user_id: "user-1",
          project_id: matterId,
          current_version_id: reviewSourceVersionId,
        },
      ],
      versions: [],
      reviews: [review],
      cells: input?.mutateFreshCell
        ? () => {
            tabularCellReads += 1;
            return tabularCellReads === 1
              ? cells
              : cells.map((cell, index) =>
                  index === 0
                    ? { ...cell, review_revision: cell.review_revision + 1 }
                    : cell,
                );
          }
        : cells,
    }),
    getTabularCellReads: () => tabularCellReads,
    snapshot: {
      task: {
        id: taskId,
        matter_id: matterId,
        goal: "Prepare the evidence inventory.",
        deliverables: [
          {
            key: "evidence-inventory",
            required: true,
            artifact_type: "tabular_review",
            purpose: "Evidence inventory",
          },
        ],
        latest_checkpoint: {
          litigation_evidence_inventory_receipt: receipt,
          litigation_evidence_review_completion: completion,
        },
        current_plan: [
          {
            id: stepId,
            status: "completed",
            attempt: input?.currentAttempt ?? receipt.attempt,
            result_data: {
              [AGENT_STEP_TABULAR_EFFECT_RECEIPT_KEY]: {
                [committed.effect_key]: committed,
              },
            },
          },
          { id: "step-verify", status: "running", attempt: 1 },
        ],
      },
      artifacts: [
        {
          artifact_type: "tabular_review" as const,
          artifact_id: receipt.review_id,
          purpose: "Evidence inventory",
        },
      ],
    },
  };
}

async function verificationPacketForLitigationCompletion(
  input?: Parameters<typeof litigationCompletionFixture>[0],
  readTabularRevisionIdentity?: Parameters<
    typeof buildCurrentAgentVerificationPacket
  >[0]["readTabularRevisionIdentity"],
) {
  const fixture = litigationCompletionFixture(input);
  return buildCurrentAgentVerificationPacket({
    db: fixture.db as never,
    snapshot: fixture.snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    readTabularRevisionIdentity,
  });
}

test("accepts an unresolved litigation review only when its current publication receipt matches", async () => {
  const result = await verificationPacketForLitigationCompletion();
  const { packet } = result;
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "tabular-review-complete:evidence-inventory",
    )?.status,
    "pass",
  );
  const identity = result.verifiedArtifacts[0];
  assert.equal(identity?.kind, "agent_verified_tabular_artifact_v1");
  if (identity?.kind === "agent_verified_tabular_artifact_v1") {
    assert.equal(identity.review_id, result.packet.deliverables[0]!.artifact_id);
    assert.match(identity.input_digest, /^[a-f0-9]{64}$/);
    assert.ok(identity.source_receipt_fingerprint);
    assert.ok(identity.decision_fingerprint);
    assert.ok(identity.completion_sha256);
  }
});

test("a changed revision fence preserves the Review and produces a structured review gap", async () => {
  let call = 0;
  const result = await verificationPacketForLitigationCompletion(
    undefined,
    async () => ({
      revision_fingerprint: call++ === 0 ? "a".repeat(64) : "b".repeat(64),
    }),
  );
  assert.equal(call, 2);
  assert.equal(result.verifiedArtifacts.length, 0);
  const issue = result.packet.deterministic_checks.find(
    (check) => check.code === "tabular-review-revision:evidence-inventory",
  )?.issue;
  assert.equal(issue?.code, "tabular_review_revision_unstable");
  assert.equal(
    issue?.code === "tabular_review_revision_unstable"
      ? issue.reason
      : null,
    "changed",
  );
});

test("a changed current binding produces a deterministic revision gap without mixing attempts", async () => {
  const fixture = litigationCompletionFixture({ mutateFreshCell: true });
  let revisionReads = 0;
  const result = await buildCurrentAgentVerificationPacket({
    db: fixture.db as never,
    snapshot: fixture.snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    readTabularRevisionIdentity: async () => {
      revisionReads += 1;
      return { revision_fingerprint: "a".repeat(64) };
    },
  });
  assert.equal(fixture.getTabularCellReads(), 2);
  assert.equal(revisionReads, 1);
  assert.equal(result.verifiedArtifacts.length, 0);
  const issue = result.packet.deterministic_checks.find(
    (check) => check.code === "tabular-review-revision:evidence-inventory",
  )?.issue;
  assert.equal(issue?.code, "tabular_review_revision_unstable");
  assert.equal(
    issue?.code === "tabular_review_revision_unstable"
      ? issue.reason
      : null,
    "input_digest_changed",
  );
});

test("generic Tabular input digests ignore receipts from an older source Step attempt", async () => {
  const result = await verificationPacketForLitigationCompletion({
    currentAttempt: 2,
  });
  assert.equal(result.verifiedArtifacts.length, 0);
  const issue = result.packet.deterministic_checks.find(
    (check) => check.code === "tabular-review-revision:evidence-inventory",
  )?.issue;
  assert.equal(issue?.code, "tabular_review_revision_unstable");
  assert.equal(
    issue?.code === "tabular_review_revision_unstable"
      ? issue.reason
      : null,
    "input_digest_unavailable",
  );
});

test("fails closed when a litigation review completion is not bound to the exact current publication", async () => {
  const cases: Array<
    [string, Parameters<typeof litigationCompletionFixture>[0]]
  > = [
    ["a later Step attempt", { currentAttempt: 2 }],
    [
      "a mismatched Tabular effect fingerprint",
      { tamperEffectFingerprint: true },
    ],
    [
      "a self-consistent but tampered source receipt",
      { tamperReceiptLayoutDigest: true },
    ],
    [
      "a completion receipt from a different Step",
      { completionStepId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    ],
    ["a mutated Review layout", { tamperReviewColumns: true }],
  ];
  for (const [label, input] of cases) {
    const { packet } = await verificationPacketForLitigationCompletion(input);
    const blockingCheck = packet.deterministic_checks.find(
      (candidate) =>
        candidate.status === "gap" &&
        [
          "tabular-review-complete:evidence-inventory",
          "tabular-review-integrity:evidence-inventory",
        ].includes(candidate.code),
    );
    assert.equal(blockingCheck?.status, "gap", label);
    assert.ok(
      ["tabular_review_incomplete", "tabular_review_invalid"].includes(
        blockingCheck?.issue?.code ?? "",
      ),
      label,
    );
  }
});

test("builds a verifier packet from the fixed current accepted view", async () => {
  const { reserved, snapshot } = fixture();
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: reserved.target.version_id,
      },
    ],
    versions: [
      {
        id: reserved.target.version_id,
        document_id: reserved.target.document_id,
        storage_path: "fixed.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const { packet } = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: true,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => "Current accepted Word text.",
  });
  assert.equal(
    packet.deliverables[0].accepted_view_text,
    "Current accepted Word text.",
  );
  assert.match(packet.deliverables[0].accepted_view_sha256 ?? "", /^sha256:/);
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "current-artifact:opinion",
    )?.status,
    "pass",
  );
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "citation-relocation",
    )?.issue?.code,
    "citation_snapshot_missing",
  );
});

test("verifies a Matter-owned Tabular Review without treating its id as a Document", async () => {
  const reviewId = "44444444-4444-4444-8444-444444444444";
  const sourceDocumentId = "55555555-5555-4555-8555-555555555555";
  const snapshot = {
    task: {
      id: taskId,
      matter_id: matterId,
      goal: "Prepare the evidence inventory.",
      deliverables: [
        {
          key: "evidence-inventory",
          title: "Evidence inventory",
          required: true,
          purpose: "Evidence inventory",
        },
      ],
      latest_checkpoint: null,
      current_plan: [
        { id: "step-create", status: "completed", attempt: 1 },
        { id: "step-verify", status: "running", attempt: 1 },
      ],
    },
    artifacts: [
      {
        artifact_type: "tabular_review" as const,
        artifact_id: reviewId,
        purpose: "Evidence inventory",
      },
    ],
  };
  const db = fakeDb({
    documents: [
      {
        id: sourceDocumentId,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: currentVersion,
      },
    ],
    versions: [],
    reviews: [
      {
        id: reviewId,
        project_id: matterId,
        user_id: "user-1",
        title: "Evidence inventory",
        row_protocol: "document_rows",
        document_ids: [sourceDocumentId],
        columns_config: [{ index: 0, name: "Evidence" }],
      },
    ],
    cells: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        review_id: reviewId,
        document_id: sourceDocumentId,
        row_id: null,
        column_index: 0,
        status: "done",
        content: '{"summary":"Source-grounded evidence"}',
        citations: [],
      },
    ],
  });

  const { packet } = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
  });
  assert.equal(packet.deliverables[0]?.artifact_id, reviewId);
  assert.equal(packet.deliverables[0]?.document_id, null);
  assert.equal(packet.deliverables[0]?.current_version_id, null);
  assert.match(
    packet.deliverables[0]?.accepted_view_text ?? "",
    /Source-grounded evidence/,
  );
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "current-artifact:evidence-inventory",
    )?.status,
    "pass",
  );
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "tabular-review-complete:evidence-inventory",
    )?.status,
    "pass",
  );
});

test("reads each fixed Tabular Review with its own bounded cell query", async () => {
  const reviewIds = [
    "44444444-4444-4444-8444-444444444441",
    "44444444-4444-4444-8444-444444444442",
  ];
  const sourceDocumentId = "55555555-5555-4555-8555-555555555555";
  const cellQueryIds: string[][] = [];
  const db = fakeDb({
    documents: [
      {
        id: sourceDocumentId,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: currentVersion,
      },
    ],
    versions: [],
    reviews: reviewIds.map((id, index) => ({
      id,
      project_id: matterId,
      user_id: "user-1",
      title: `Review ${index + 1}`,
      row_protocol: "document_rows",
      document_ids: [sourceDocumentId],
      columns_config: [{ index: 0, name: "Evidence" }],
    })),
    cells: reviewIds.map((reviewId, index) => ({
      id: `66666666-6666-4666-8666-66666666666${index}`,
      review_id: reviewId,
      document_id: sourceDocumentId,
      row_id: null,
      column_index: 0,
      status: "done",
      content: `Review ${index + 1} finding`,
      citations: [],
    })),
    cellQueryIds,
  });
  const snapshot = {
    task: {
      id: taskId,
      matter_id: matterId,
      goal: "Verify both fixed reviews.",
      deliverables: reviewIds.map((_, index) => ({
        key: `review-${index + 1}`,
        title: `Review ${index + 1}`,
        required: true,
        artifact_type: "tabular_review" as const,
        purpose: `Review ${index + 1}`,
      })),
      latest_checkpoint: null,
      current_plan: [
        { id: "step-create", status: "completed", attempt: 1 },
        { id: "step-verify", status: "running", attempt: 1 },
      ],
    },
    artifacts: reviewIds.map((artifactId, index) => ({
      artifact_type: "tabular_review" as const,
      artifact_id: artifactId,
      purpose: `Review ${index + 1}`,
    })),
  };
  const { packet } = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
  });
  assert.deepEqual(cellQueryIds, [[reviewIds[0]!], [reviewIds[1]!]]);
  assert.deepEqual(
    packet.deliverables.map((deliverable) => deliverable.artifact_id),
    reviewIds,
  );
});

test("a Tabular accepted-view scope gap records complete fallback characters, never a cell count", async () => {
  const reviewId = "44444444-4444-4444-8444-444444444444";
  const sourceDocumentId = "55555555-5555-4555-8555-555555555555";
  const columns = Array.from({ length: 501 }, (_, index) => ({
    index,
    name: `Evidence ${index}`,
  }));
  const cells = columns.map((column, index) => ({
    id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
    review_id: reviewId,
    document_id: sourceDocumentId,
    row_id: null,
    column_index: column.index,
    status: "done",
    content: `Fixed source-grounded evidence ${index}.`,
    citations: [],
    review_status: "unresolved",
    reviewed_at: "2026-08-08T00:00:00.000Z",
    review_revision: 1,
  }));
  const reservation = buildAgentStepTabularEffectReservation({
    stepId: "77777777-7777-4777-8777-777777777777",
    attempt: 1,
    reviewId,
    layout: {
      document_ids: [sourceDocumentId],
      columns_config: columns,
      cells: cells.map((cell) => ({
        id: cell.id,
        document_id: sourceDocumentId,
        column_index: cell.column_index,
      })),
    },
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const committed = {
    ...reservation,
    status: "committed" as const,
    effect: { review_id: reviewId, artifact_type: "tabular_review" as const },
    committed_at: "2026-08-08T00:01:00.000Z",
  };
  const { packet, verifiedArtifacts } = await buildCurrentAgentVerificationPacket({
    db: fakeDb({
      documents: [
        {
          id: sourceDocumentId,
          user_id: "user-1",
          project_id: matterId,
          current_version_id: currentVersion,
        },
      ],
      versions: [],
      reviews: [
        {
          id: reviewId,
          project_id: matterId,
          user_id: "user-1",
          title: "Large evidence inventory",
          practice: "litigation",
          row_protocol: "document_rows",
          workflow_id: null,
          document_ids: [sourceDocumentId],
          columns_config: columns,
        },
      ],
      cells,
    }) as never,
    snapshot: {
      task: {
        id: taskId,
        matter_id: matterId,
        goal: "Prepare the evidence inventory.",
        deliverables: [
          {
            key: "evidence-inventory",
            title: "Evidence inventory",
            required: true,
            artifact_type: "tabular_review",
            purpose: "Evidence inventory",
          },
        ],
        latest_checkpoint: null,
        current_plan: [
          {
            id: reservation.step_id,
            status: "completed",
            attempt: reservation.attempt,
            result_data: {
              [AGENT_STEP_TABULAR_EFFECT_RECEIPT_KEY]: {
                [committed.effect_key]: committed,
              },
            },
          },
          { id: "step-verify", status: "running", attempt: 1 },
        ],
      },
      artifacts: [
        {
          artifact_type: "tabular_review",
          artifact_id: reviewId,
          purpose: "Evidence inventory",
        },
      ],
    },
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
  });
  assert.equal(verifiedArtifacts.length, 0);
  const issue = packet.deterministic_checks.find(
    (check) => check.code === "verification-scope:evidence-inventory",
  )?.issue;
  assert.equal(issue?.code, "verification_scope_exceeded");
  assert.ok(
    issue?.code === "verification_scope_exceeded" &&
      issue.accepted_view_characters > cells.length,
  );
});

test("keeps a partial Tabular Review as a bounded review gap", async () => {
  const reviewId = "77777777-7777-4777-8777-777777777777";
  const sourceDocumentId = "88888888-8888-4888-8888-888888888888";
  const snapshot = {
    task: {
      id: taskId,
      matter_id: matterId,
      goal: "Prepare the evidence inventory.",
      deliverables: [
        {
          key: "evidence-inventory",
          required: true,
          artifact_type: "tabular_review",
          purpose: "Evidence inventory",
        },
      ],
      latest_checkpoint: null,
      current_plan: [
        { id: "step-create", status: "completed", attempt: 1 },
        { id: "step-verify", status: "running", attempt: 1 },
      ],
    },
    artifacts: [
      {
        artifact_type: "tabular_review" as const,
        artifact_id: reviewId,
        purpose: "Evidence inventory",
      },
    ],
  };
  const { packet } = await buildCurrentAgentVerificationPacket({
    db: fakeDb({
      documents: [
        {
          id: sourceDocumentId,
          user_id: "user-1",
          project_id: matterId,
          current_version_id: currentVersion,
        },
      ],
      versions: [],
      reviews: [
        {
          id: reviewId,
          project_id: matterId,
          user_id: "user-1",
          title: "Evidence inventory",
          row_protocol: "document_rows",
          document_ids: [sourceDocumentId],
          columns_config: [{ index: 0, name: "Evidence" }],
        },
      ],
      cells: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          review_id: reviewId,
          document_id: sourceDocumentId,
          row_id: null,
          column_index: 0,
          status: "pending",
          content: null,
          citations: [],
        },
      ],
    }) as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
  });
  const check = packet.deterministic_checks.find(
    (candidate) =>
      candidate.code === "tabular-review-complete:evidence-inventory",
  );
  assert.equal(check?.status, "gap");
  assert.deepEqual(check?.issue, {
    code: "tabular_review_incomplete",
    deliverable_key: "evidence-inventory",
    review_id: reviewId,
    total_cells: 1,
    incomplete_cells: 1,
  });
  assert.match(
    packet.deliverables[0]?.accepted_view_text ?? "",
    /status=pending/,
  );
});

test("fixed effect Version drift stops before accepted-view loading", async () => {
  const { reserved, snapshot } = fixture();
  let loaded = false;
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: currentVersion,
      },
    ],
    versions: [
      {
        id: currentVersion,
        document_id: reserved.target.document_id,
        storage_path: "changed.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const { packet } = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => {
      loaded = true;
      return "Changed text";
    },
  });
  assert.equal(loaded, false);
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "artifact-version:opinion",
    )?.issue?.code,
    "artifact_version_changed",
  );
});

test("oversized accepted views become bounded review projections, not failures", async () => {
  const { reserved, snapshot } = fixture();
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: reserved.target.version_id,
      },
    ],
    versions: [
      {
        id: reserved.target.version_id,
        document_id: reserved.target.document_id,
        storage_path: "long.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const { packet } = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => "长".repeat(120_000),
  });
  assert.equal(packet.deliverables[0].accepted_view_complete, false);
  assert.match(
    packet.deliverables[0].accepted_view_text ?? "",
    /INCOMPLETE VERIFICATION PROJECTION/,
  );
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "verification-scope:opinion",
    )?.issue?.code,
    "verification_scope_exceeded",
  );
});

test("Contract Pack gaps are appended as structured deterministic checks", async () => {
  const { reserved, snapshot } = fixture();
  snapshot.task.deliverables[0]!.key = "review-opinion";
  snapshot.task.deliverables[0]!.purpose = "Review opinion";
  snapshot.artifacts[0]!.purpose = "Review opinion";
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: reserved.target.version_id,
      },
    ],
    versions: [
      {
        id: reserved.target.version_id,
        document_id: reserved.target.document_id,
        storage_path: "opinion.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const { packet } = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile: {
      kind: "agent_verifier_profile_v1",
      id: "work_task_contract_docx_v1",
      version: "1.0.0",
      semantic_goal_check: true,
      repair_policy: "none",
    },
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => "Current review opinion.",
  });
  const check = packet.deterministic_checks.find(
    (candidate) => candidate.code === "contract-playbook-pack",
  );
  assert.equal(check?.status, "gap");
  assert.equal(check?.issue?.code, "pack_check_gap");
  assert.deepEqual(
    check?.issue?.code === "pack_check_gap" ? check.issue.facts : null,
    {
      issues: [{ code: "receipt_missing", finding_id: null, rule_id: null }],
    },
  );
});
