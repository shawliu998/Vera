import type { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import { loadActiveVersion } from "./documentVersions";
import {
  buildAgentStepEffectReservation,
  commitAgentStepEffect,
  reserveAgentStepEffect,
} from "./agent-kernel/effects/stepEffect";
import {
  compileContractPlaybookMaterializationPlan,
  type ContractPlaybookMaterializationPlanV1,
} from "./agent-packs/contract/contractPlaybookMaterialization";
import type { ContractPlaybookReceiptV1 } from "./agent-packs/contract/contractPlaybookPack";
import {
  ContractPlaybookWordMaterializationError,
  materializeContractPlaybookWordDocuments,
} from "./agentContractPlaybookWordMaterializer";
import {
  bindGeneratedTaskWordArtifact,
  generateDocx,
  persistGeneratedDocxBytes,
  type GeneratedMutationIdentity,
} from "./chat/tools/documentOps";
import {
  appendCurrentDocxVersion,
  durableCurrentVersionMutationId,
} from "./currentDocumentVersionMutation";

type Db = ReturnType<typeof createServerSupabase>;

export const CONTRACT_PLAYBOOK_MATERIALIZED_DELIVERABLE_KEYS = [
  "contract-revision",
  "contract-clean",
  "review-opinion",
] as const;

export type ContractPlaybookMaterializedDeliverableKey =
  (typeof CONTRACT_PLAYBOOK_MATERIALIZED_DELIVERABLE_KEYS)[number];

export function isContractPlaybookMaterializedDeliverableKey(
  value: string,
): value is ContractPlaybookMaterializedDeliverableKey {
  return (
    CONTRACT_PLAYBOOK_MATERIALIZED_DELIVERABLE_KEYS as readonly string[]
  ).includes(value);
}

export function buildContractPlaybookMaterializationEffectInput(input: {
  plan: ContractPlaybookMaterializationPlanV1;
  deliverableKey: ContractPlaybookMaterializedDeliverableKey;
}) {
  return {
    kind: "contract_playbook_server_materialization_v1" as const,
    materialization_plan_fingerprint: input.plan.receipt_fingerprint,
    source_document_id: input.plan.source.document_id,
    source_version_id: input.plan.source.version_id,
    deliverable_key: input.deliverableKey,
  };
}

function deliverableTitle(key: ContractPlaybookMaterializedDeliverableKey) {
  return key === "contract-revision"
    ? "Contract Revision"
    : key === "contract-clean"
      ? "Contract Clean Copy"
      : "Contract Review Opinion";
}

function sourceReviewConditionSection(input: {
  receipt: ContractPlaybookReceiptV1;
  markupCount: number;
}) {
  if (!input.markupCount) return null;
  const zh = `固定源合同包含 ${input.markupCount} 项既有修订或批注。原始版本保持不变；本任务的派生修订稿和清洁稿以该源文件的接受视图为基础，既有修订或批注不作为 Vera 新建议。`;
  const en = `The fixed source contract contains ${input.markupCount} pre-existing revision or comment item(s). The source Version remains unchanged; derived revision and clean outputs use its accepted view, and the pre-existing markup is not represented as a new Vera recommendation.`;
  const content =
    input.receipt.opinion_language === "zh"
      ? zh
      : input.receipt.opinion_language === "en"
        ? en
        : `${zh}\n${en}`;
  return {
    heading:
      input.receipt.opinion_language === "zh"
        ? "源文件修订状态"
        : input.receipt.opinion_language === "en"
          ? "Source review-markup condition"
          : "源文件修订状态\nSource review-markup condition",
    level: 1,
    content,
  };
}

async function loadFixedContractBytes(input: {
  db: Db;
  userId: string;
  matterId: string;
  receipt: ContractPlaybookReceiptV1;
}) {
  const { data: document, error: documentError } = await input.db
    .from("documents")
    .select("id,user_id,project_id,current_version_id")
    .eq("id", input.receipt.contract.document_id)
    .maybeSingle();
  if (documentError) throw new Error(documentError.message);
  if (
    !document ||
    document.user_id !== input.userId ||
    document.project_id !== input.matterId ||
    document.current_version_id !== input.receipt.contract.version_id
  ) {
    throw new ContractPlaybookWordMaterializationError(
      "source_version_unavailable",
      {
        document_id: input.receipt.contract.document_id,
        version_id: input.receipt.contract.version_id,
      },
    );
  }
  const version = await loadActiveVersion(
    input.receipt.contract.document_id,
    input.db,
    input.receipt.contract.version_id,
  );
  if (
    !version ||
    version.id !== input.receipt.contract.version_id ||
    version.file_type?.toLowerCase() !== "docx"
  ) {
    throw new ContractPlaybookWordMaterializationError(
      "source_version_unavailable",
      {
        document_id: input.receipt.contract.document_id,
        version_id: input.receipt.contract.version_id,
      },
    );
  }
  const raw = await downloadFile(version.storage_path);
  if (!raw) {
    throw new ContractPlaybookWordMaterializationError(
      "source_version_unavailable",
      { version_id: input.receipt.contract.version_id },
    );
  }
  return Buffer.from(raw);
}

function persistedIdentity(input: {
  receipt: Awaited<ReturnType<typeof reserveAgentStepEffect>>;
  taskId: string;
  matterId: string;
  deliverableKey: ContractPlaybookMaterializedDeliverableKey;
}): GeneratedMutationIdentity {
  return {
    documentId: input.receipt.target.document_id,
    versionId: input.receipt.target.version_id,
    taskWordArtifact: {
      taskId: input.taskId,
      projectId: input.matterId,
      deliverableKey: input.deliverableKey,
    },
  };
}

function assertPersistedDocument(
  value: Awaited<ReturnType<typeof persistGeneratedDocxBytes>>,
) {
  if (
    "error" in value ||
    !value.document_id ||
    !value.version_id ||
    !value.filename
  ) {
    throw new Error(
      "error" in value
        ? value.error
        : "Server-materialized Contract DOCX was not persisted",
    );
  }
  return value;
}

function assertBuiltDocx(value: Awaited<ReturnType<typeof generateDocx>>) {
  if (
    !value ||
    !("buffer" in value) ||
    !Buffer.isBuffer(value.buffer) ||
    !("filename" in value) ||
    typeof value.filename !== "string"
  ) {
    throw new Error(
      "error" in value
        ? value.error
        : "Server-materialized Contract opinion bytes were not built",
    );
  }
  return value;
}

async function loadExistingDeliverableVersion(input: {
  db: Db;
  userId: string;
  matterId: string;
  documentId: string | null;
}) {
  if (!input.documentId) return null;
  const { data: document, error } = await input.db
    .from("documents")
    .select("id,user_id,project_id,current_version_id")
    .eq("id", input.documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !document ||
    document.user_id !== input.userId ||
    document.project_id !== input.matterId ||
    !document.current_version_id
  ) {
    throw new Error(
      "The current Contract deliverable is unavailable for versioned revision",
    );
  }
  return {
    documentId: document.id as string,
    versionId: document.current_version_id as string,
  };
}

/**
 * Execute one Contract Playbook creation Step without a drafting model. The
 * server compiles all three outputs from one receipt while reusing the normal
 * Step effect, fixed Document/Version, Task Word receipt, ArtifactLink and
 * current-Version recovery boundaries.
 */
export async function executeContractPlaybookMaterializationStep(input: {
  db: Db;
  userId: string;
  taskId: string;
  matterId: string;
  stepId: string;
  attempt: number;
  leaseOwner: string;
  receipt: ContractPlaybookReceiptV1;
  deliverableKey: ContractPlaybookMaterializedDeliverableKey;
  artifactPurpose: string;
  existingArtifactId?: string | null;
  shouldContinue?: () => Promise<boolean>;
}) {
  const plan = compileContractPlaybookMaterializationPlan(input.receipt);
  if (plan.status !== "ready") {
    throw new ContractPlaybookWordMaterializationError("plan_review_required", {
      issues: plan.issues,
    });
  }
  if (input.shouldContinue && !(await input.shouldContinue())) {
    throw new Error(
      "Contract materialization was interrupted before source read",
    );
  }
  const sourceBytes = await loadFixedContractBytes(input);
  const documents = await materializeContractPlaybookWordDocuments({
    sourceBytes,
    plan,
    author: "Vera",
    initials: "V",
  });
  const effectInput = buildContractPlaybookMaterializationEffectInput({
    plan,
    deliverableKey: input.deliverableKey,
  });
  const existing = await loadExistingDeliverableVersion({
    db: input.db,
    userId: input.userId,
    matterId: input.matterId,
    documentId: input.existingArtifactId ?? null,
  });
  const revisionMutationKey = existing
    ? [
        "contract-playbook-materialization-v2",
        input.taskId,
        input.stepId,
        input.attempt,
        input.deliverableKey,
        plan.receipt_fingerprint,
        existing.versionId,
      ].join(":")
    : null;
  const wanted = buildAgentStepEffectReservation({
    stepId: input.stepId,
    attempt: input.attempt,
    toolName: "generate_docx",
    toolInput: effectInput,
    ...(existing && revisionMutationKey
      ? {
          target: {
            documentId: existing.documentId,
            versionId: durableCurrentVersionMutationId(revisionMutationKey),
          },
        }
      : {}),
  });
  const effect = await reserveAgentStepEffect(input.db, {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    receipt: wanted,
  });
  if (input.shouldContinue && !(await input.shouldContinue())) {
    throw new Error(
      "Contract materialization was interrupted before publication",
    );
  }
  const mutationIdentity = persistedIdentity({
    receipt: effect,
    taskId: input.taskId,
    matterId: input.matterId,
    deliverableKey: input.deliverableKey,
  });
  const title = deliverableTitle(input.deliverableKey);
  const sourceCondition = sourceReviewConditionSection({
    receipt: input.receipt,
    markupCount: documents.sourceReviewMarkupCount,
  });
  const outputBuffer =
    input.deliverableKey === "review-opinion"
      ? assertBuiltDocx(
          await generateDocx(
            plan.opinion.title || title,
            sourceCondition
              ? [
                  plan.opinion.sections[0],
                  sourceCondition,
                  ...plan.opinion.sections.slice(1),
                ]
              : plan.opinion.sections,
            input.userId,
            input.db,
            {
              projectId: input.matterId,
              filenameTitle: title,
              bytesOnly: true,
            },
          ),
        ).buffer
      : input.deliverableKey === "contract-revision"
        ? documents.revisionBytes
        : documents.cleanBytes;
  const persisted = existing
    ? await (async () => {
        const bound = await bindGeneratedTaskWordArtifact({
          extension: "docx",
          buffer: outputBuffer,
          projectId: input.matterId,
          mutationIdentity,
        });
        const appended = await appendCurrentDocxVersion({
          db: input.db,
          userId: input.userId,
          projectId: input.matterId,
          documentId: existing.documentId,
          baseVersionId: existing.versionId,
          mutationKey: revisionMutationKey!,
          filename: `${title}.docx`,
          buffer: bound,
          source: "generated",
          beforeActivate: input.shouldContinue
            ? async () => {
                if (!(await input.shouldContinue?.())) {
                  throw new Error(
                    "Contract materialization was interrupted before Version activation",
                  );
                }
              }
            : undefined,
        });
        return {
          document_id: appended.document_id,
          version_id: appended.version_id,
          filename: appended.filename,
        };
      })()
    : assertPersistedDocument(
        await persistGeneratedDocxBytes({
          title,
          buffer: outputBuffer,
          userId: input.userId,
          db: input.db,
          projectId: input.matterId,
          mutationIdentity,
        }),
      );
  if (
    persisted.document_id !== effect.target.document_id ||
    persisted.version_id !== effect.target.version_id
  ) {
    throw new Error(
      "Server-materialized Contract document did not match its reserved effect",
    );
  }
  await commitAgentStepEffect(input.db, {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    receipt: effect,
    artifactType: "draft",
    documentId: persisted.document_id,
    versionId: persisted.version_id,
  });
  return {
    summary:
      input.deliverableKey === "contract-revision"
        ? `Created the fixed Contract revision with ${documents.trackedChanges.length} native tracked change(s) and ${documents.comments.length} native comment(s).${documents.sourceReviewMarkupCount ? ` The immutable source contained ${documents.sourceReviewMarkupCount} pre-existing review item(s); derived outputs use its accepted view.` : ""}`
        : input.deliverableKey === "contract-clean"
          ? "Created the clean Contract from the revision accepted view and confirmed that no review markup remains."
          : "Created the Contract review opinion from the same fixed findings and lawyer dispositions used for the revision.",
    artifacts: [
      {
        artifact_type: "draft" as const,
        artifact_id: persisted.document_id,
        purpose: input.artifactPurpose,
      },
    ],
    waitingForInput: false,
    citationCheck: { total: 0, relocatable: 0, missing: 0 },
  };
}
