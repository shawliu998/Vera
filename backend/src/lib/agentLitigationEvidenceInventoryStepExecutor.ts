import { z } from "zod";

import {
  AgentTaskExecutionInterruptedError,
  type AgentStepExecutionResult,
} from "./agentStepExecutor";
import type { createServerSupabase } from "./supabase";
import { executeLitigationEvidenceInventoryPublication } from "./agentLitigationEvidenceInventoryExecutor";
import {
  generateLitigationEvidenceDocumentCells,
  litigationEvidenceCitationIsExact,
  loadFixedLitigationEvidenceSource,
  type LitigationEvidenceProviderComplete,
} from "./agentLitigationEvidenceInventoryGeneration";
import { readAgentStepTabularEffectReceipts } from "./agent-kernel/effects/tabularEffect";
import type { AgentStepContractV1 } from "./agent-kernel/contracts/stepContract";
import { createAgentRequiredInput } from "./agent-kernel/contracts/requiredInput";
import {
  LITIGATION_HEARING_PREPARATION_WORKFLOW_ID,
  contextMatchesLitigationReceipt,
  type LitigationEvidenceInventoryContextV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryContext";
import {
  preserveLitigationEvidenceCellGap,
  type LitigationEvidenceField,
  type LitigationEvidenceInventoryReceiptV1,
} from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  compileLitigationEvidenceReviewCompletionReceipt,
  inspectLitigationEvidenceInventoryReview,
  litigationEvidenceStoredCellSchema,
} from "./agent-packs/litigation/litigationEvidenceInventoryReview";
import type { UserApiKeys } from "./llm";
import { commitAgentLitigationEvidenceCell } from "./agentLitigationEvidenceCellRepository";

type Db = ReturnType<typeof createServerSupabase>;

type Snapshot = {
  task: {
    id: string;
    matter_id: string;
    user_id: string;
    latest_checkpoint?: unknown;
  };
};

type RunningStep = {
  id: string;
  attempt: number;
  result_data?: unknown;
};

export function isLitigationEvidenceInventoryCreationStep(input: {
  workflowId: string | null | undefined;
  contract: AgentStepContractV1 | null | undefined;
}) {
  const contract = input.contract;
  return Boolean(
    input.workflowId === LITIGATION_HEARING_PREPARATION_WORKFLOW_ID &&
    contract?.capability === "create_tabular" &&
    contract.operation === "table.create" &&
    contract.output_expectation.kind === "artifact" &&
    contract.output_expectation.artifact_type === "tabular_review" &&
    contract.output_expectation.deliverable_key === "evidence-inventory",
  );
}

async function readStoredCells(input: {
  db: Db;
  receipt: LitigationEvidenceInventoryReceiptV1;
}) {
  const { data, error } = await input.db
    .from("tabular_cells")
    .select(
      "id,review_id,document_id,row_id,column_index,status,content,citations,review_status,reviewed_at,review_revision",
    )
    .eq("review_id", input.receipt.review_id);
  if (error) throw new Error(error.message);
  return z.array(litigationEvidenceStoredCellSchema).parse(data ?? []);
}

function readCurrentAttemptPublication(step: RunningStep, reviewId: string) {
  const matching = readAgentStepTabularEffectReceipts(step.result_data).filter(
    (receipt) =>
      receipt.status === "committed" &&
      receipt.step_id === step.id &&
      receipt.attempt === step.attempt &&
      receipt.effect?.review_id === reviewId,
  );
  if (matching.length !== 1) {
    throw new Error(
      "The current Litigation Evidence Inventory publication is not committed",
    );
  }
}

function pendingFieldsByDocument(input: {
  receipt: LitigationEvidenceInventoryReceiptV1;
  inspection: ReturnType<typeof inspectLitigationEvidenceInventoryReview>;
}) {
  const storedById = new Map(
    input.inspection.cells.map((cell) => [cell.id, cell]),
  );
  return input.receipt.source_pins.map((pin) => ({
    documentId: pin.document_id,
    fields: input.receipt.cells.flatMap((fixed) => {
      const stored = storedById.get(fixed.cell_id)!;
      return fixed.document_id === pin.document_id &&
        stored.status === "pending" &&
        stored.review_status === null
        ? [fixed.field]
        : [];
    }),
  }));
}

async function assertVerifiedCitationsRemainExact(input: {
  db: Db;
  receipt: LitigationEvidenceInventoryReceiptV1;
  userId: string;
  inspection: ReturnType<typeof inspectLitigationEvidenceInventoryReview>;
}) {
  const sources = new Map<
    string,
    Awaited<ReturnType<typeof loadFixedLitigationEvidenceSource>>
  >();
  for (const cell of input.inspection.cells) {
    if (cell.review_status !== "verified") continue;
    const content = input.inspection.generatedContent.get(cell.id);
    if (!content) {
      throw new Error("A verified Evidence Inventory Cell has no content");
    }
    let source = sources.get(cell.document_id);
    if (!source) {
      source = await loadFixedLitigationEvidenceSource({
        db: input.db,
        receipt: input.receipt,
        documentId: cell.document_id,
        userId: input.userId,
      });
      sources.set(cell.document_id, source);
    }
    for (const citation of content.candidate.citations) {
      if (
        !litigationEvidenceCitationIsExact({
          source: source.source,
          quote: citation.quote,
          locator: citation.locator,
          versionId: citation.version_id,
          currentVersionId: source.currentVersionId,
        })
      ) {
        throw new Error(
          "A lawyer-verified Evidence Inventory citation no longer relocates exactly",
        );
      }
    }
  }
}

export type LitigationEvidenceInventoryStepOutcome =
  | {
      kind: "awaiting_lawyer_review";
      result: AgentStepExecutionResult;
      receipt: LitigationEvidenceInventoryReceiptV1;
      issues: ReturnType<typeof preserveLitigationEvidenceCellGap>[];
    }
  | {
      kind: "completed";
      result: AgentStepExecutionResult;
      receipt: LitigationEvidenceInventoryReceiptV1;
      completion: ReturnType<
        typeof compileLitigationEvidenceReviewCompletionReceipt
      >;
    };

export async function executeLitigationEvidenceInventoryStep(input: {
  db: Db;
  snapshot: Snapshot;
  userId: string;
  leaseOwner: string;
  step: RunningStep;
  context: LitigationEvidenceInventoryContextV1;
  declaredTaskDeliverablePurpose: string;
  model: string;
  apiKeys?: UserApiKeys;
  complete: LitigationEvidenceProviderComplete;
  shouldContinue: () => Promise<boolean>;
  recordPublicationCheckpoint: (input: {
    receipt: LitigationEvidenceInventoryReceiptV1;
    artifact: {
      artifact_type: "tabular_review";
      artifact_id: string;
      purpose: string;
    };
  }) => Promise<boolean>;
}): Promise<LitigationEvidenceInventoryStepOutcome> {
  const publication = await executeLitigationEvidenceInventoryPublication({
    db: input.db,
    taskId: input.snapshot.task.id,
    matterId: input.snapshot.task.matter_id,
    stepId: input.step.id,
    attempt: input.step.attempt,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    context: input.context,
    declaredTaskDeliverablePurpose: input.declaredTaskDeliverablePurpose,
  });
  if (
    !contextMatchesLitigationReceipt({
      context: input.context,
      receipt: publication.receipt,
    })
  ) {
    throw new Error(
      "Litigation Evidence Inventory context and receipt do not match",
    );
  }
  if (
    !(await input.recordPublicationCheckpoint({
      receipt: publication.receipt,
      artifact: publication.artifact,
    }))
  ) {
    throw new AgentTaskExecutionInterruptedError();
  }

  // The checkpoint callback updates the Task receipt; the Step effect itself
  // was committed by publication and remains visible on this fixed Step.
  const stepRead = await input.db
    .from("agent_steps")
    .select("result_data")
    .eq("id", input.step.id)
    .eq("task_id", input.snapshot.task.id)
    .maybeSingle();
  if (stepRead.error) throw new Error(stepRead.error.message);
  readCurrentAttemptPublication(
    { ...input.step, result_data: stepRead.data?.result_data },
    publication.receipt.review_id,
  );

  let stored = await readStoredCells({
    db: input.db,
    receipt: publication.receipt,
  });
  let inspection = inspectLitigationEvidenceInventoryReview({
    receipt: publication.receipt,
    cells: stored,
  });
  const issues: ReturnType<typeof preserveLitigationEvidenceCellGap>[] = [];

  for (const document of pendingFieldsByDocument({
    receipt: publication.receipt,
    inspection,
  })) {
    if (!document.fields.length) continue;
    if (!(await input.shouldContinue())) {
      throw new AgentTaskExecutionInterruptedError();
    }
    const fixed = await loadFixedLitigationEvidenceSource({
      db: input.db,
      receipt: publication.receipt,
      documentId: document.documentId,
      userId: input.userId,
    });
    const generation = await generateLitigationEvidenceDocumentCells({
      receipt: publication.receipt,
      documentId: document.documentId,
      fields: document.fields as LitigationEvidenceField[],
      source: fixed.source,
      currentVersionId: fixed.currentVersionId,
      outputLanguage: input.context.output_language,
      model: input.model,
      apiKeys: input.apiKeys,
      complete: input.complete,
      commit: async (cell) => {
        const expected = publication.receipt.cells.find(
          (candidate) => candidate.cell_id === cell.cellId,
        )!;
        const committed = await commitAgentLitigationEvidenceCell(input.db, {
          taskId: input.snapshot.task.id,
          userId: input.userId,
          stepId: input.step.id,
          attempt: input.step.attempt,
          leaseOwner: input.leaseOwner,
          reviewId: publication.receipt.review_id,
          cellId: cell.cellId,
          documentId: expected.document_id,
          versionId: expected.version_id,
          columnIndex: expected.field_index,
          content: cell.content,
          citations: cell.citations,
        });
        if (
          !["committed", "recovered", "review_locked"].includes(
            committed.outcome,
          )
        ) {
          throw new Error(
            "The generated Evidence Inventory Cell was not committed",
          );
        }
      },
    });
    for (const gap of generation.gaps) {
      issues.push(
        preserveLitigationEvidenceCellGap({
          receipt: publication.receipt,
          cellId: gap.cellId,
          reason: gap.reason,
          attemptsExhausted: gap.attemptsExhausted,
          completedCellsPreserved:
            inspection.progress.generated + generation.completedFields.length,
        }),
      );
    }
    stored = await readStoredCells({
      db: input.db,
      receipt: publication.receipt,
    });
    inspection = inspectLitigationEvidenceInventoryReview({
      receipt: publication.receipt,
      cells: stored,
    });
  }

  stored = await readStoredCells({
    db: input.db,
    receipt: publication.receipt,
  });
  inspection = inspectLitigationEvidenceInventoryReview({
    receipt: publication.receipt,
    cells: stored,
  });
  const citationTotal = [...inspection.generatedContent.values()].reduce(
    (total, content) => total + (content?.candidate.citations.length ?? 0),
    0,
  );
  const baseResult = {
    artifacts: [publication.artifact],
    citationCheck: {
      total: citationTotal,
      relocatable: citationTotal,
      missing: 0,
    },
    committedVersionId: null,
  };

  if (!inspection.complete) {
    const requiredInput = createAgentRequiredInput({
      stepId: input.step.id,
      reasonCode: "lawyer_choice",
      prompt:
        "Review the linked Evidence Inventory. Verify supported findings, keep unprovable findings unresolved, and return when every Cell has a lawyer disposition.",
      items: [
        {
          id: "evidence-inventory-reviewed",
          kind: "choice",
          question:
            "Have all Evidence Inventory findings been reviewed in the linked Tabular Review?",
          options: [{ value: "review_complete", label: "Review complete" }],
          allow_other: false,
          other_label: "Other",
        },
      ],
      resumeStrategy: "retry_step",
    });
    return {
      kind: "awaiting_lawyer_review",
      receipt: publication.receipt,
      issues,
      result: {
        ...baseResult,
        summary: issues.length
          ? `Evidence Inventory preserved ${inspection.progress.generated} generated Cell(s); ${issues.length} source-bound gap(s) require lawyer disposition in the same Review.`
          : `Evidence Inventory generated ${inspection.progress.generated} of ${inspection.progress.total} Cell(s) and is ready for lawyer source review.`,
        waitingForInput: true,
        requiredInput,
        checkpointValues: {
          litigation_evidence_inventory_receipt: publication.receipt,
          litigation_evidence_inventory_generation_issues: issues,
        },
      },
    };
  }

  await assertVerifiedCitationsRemainExact({
    db: input.db,
    receipt: publication.receipt,
    userId: input.userId,
    inspection,
  });
  const completion = compileLitigationEvidenceReviewCompletionReceipt({
    receipt: publication.receipt,
    cells: stored,
  });
  return {
    kind: "completed",
    receipt: publication.receipt,
    completion,
    result: {
      ...baseResult,
      summary: `Evidence Inventory lawyer review completed: ${inspection.progress.verified} verified and ${inspection.progress.unresolved} kept unresolved.`,
      waitingForInput: false,
      checkpointValues: {
        litigation_evidence_inventory_receipt: publication.receipt,
        litigation_evidence_review_completion: completion,
      },
    },
  };
}
