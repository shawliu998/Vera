import {
  buildDocContext,
  buildMessages,
  buildWorkflowStore,
  runLLMStream,
  stripTransientAssistantEvents,
  type AssistantEvent,
  type ChatMessage,
  type ToolInvocation,
} from "./chat";
import {
  addAgentArtifactLinks,
  readAgentTaskSupplementalInput,
  type AgentArtifactLinkInput,
} from "./agentTasks";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";
import { DEFAULT_MAIN_MODEL, providerForModel } from "./llm";
import {
  findDeliverableArtifact,
  requiredTaskDeliverables,
  taskDeliverablePurpose,
} from "./agentTaskDeliverables";
import {
  inferGoalProfile,
  resolveAgentWorkflowConstraint,
} from "./agentTaskPlanner";
import { getAgentTaskEvidence } from "./agentTaskEvidence";
import {
  MatterContextInvalidError,
  readFixedMatterContext,
} from "./agent-kernel/context/matterContext";
import {
  readAgentStepContracts,
  type AgentStepContractV1,
} from "./agent-kernel/contracts/stepContract";
import {
  readAgentStepCapabilityGrants,
  resolveBoundedRepairToolNames,
  WORK_TASK_HOST_TOOL_NAMES,
} from "./agent-kernel/capability/stepCapability";
import {
  readResolvedRequiredInputIds,
  requiredInputFromAssistantEvents,
  createDocumentsRequiredInput,
  type AgentRequiredInputV1,
} from "./agent-kernel/contracts/requiredInput";
import {
  isValidGenerateDocxInput,
  isValidGenerateExcelInput,
} from "./chat/tools/documentOps";
import {
  buildAgentStepEffectReservation,
  commitAgentStepEffect,
  reserveAgentStepEffect,
  type AgentStepEffectReceiptV1,
  type AgentStepMutationTool,
} from "./agent-kernel/effects/stepEffect";
import {
  mergeAgentVerificationResultV1,
  parseAgentSemanticVerifierResult,
  type AgentVerificationPacketV1,
  type AgentVerificationResultV1,
} from "./agent-kernel/verification/verifierCore";
import { buildCurrentAgentVerificationPacket } from "./agentTaskVerificationRepository";

type Db = ReturnType<typeof createServerSupabase>;

type TaskSnapshot = Awaited<
  ReturnType<typeof import("./agentTasks").getAgentTaskSnapshot>
>;

export function agentStepCreationKind(step: {
  title?: string | null;
  expected_output?: string | null;
}) {
  const title = step.title ?? "";
  const text = `${title} ${step.expected_output ?? ""}`;
  if (
    /create|build|generate|produce|生成|创建|制作/i.test(title) &&
    /table|matrix|excel|workbook|spreadsheet|表格|矩阵|清单/i.test(text)
  ) {
    return "tabular_review" as const;
  }
  if (
    /draft|create|generate|produce|revise|proofread|起草|撰写|生成|创建|修订|校对/i.test(
      title,
    ) &&
    /memo|draft|document|word|\.docx|work product|备忘录|文档|草稿/i.test(text)
  ) {
    return "draft" as const;
  }
  return null;
}

function taskPrompt(
  snapshot: NonNullable<TaskSnapshot>,
  stepIndex: number,
  artifactManifest: string[],
  workflowInstruction?: string,
) {
  const currentStep = snapshot.task.current_plan[stepIndex];
  const completed = snapshot.task.current_plan
    .filter((step: { status: string }) => step.status === "completed")
    .map(
      (step: { title: string; result_summary: string | null }) =>
        `- ${step.title}: ${step.result_summary ?? "Completed"}`,
    );
  const latestReview = snapshot.review.decisions.at(-1) ?? null;
  const supplementalInput = readAgentTaskSupplementalInput(snapshot.task);
  const currentSupplement =
    supplementalInput &&
    supplementalInput.step_id === currentStep?.id &&
    supplementalInput.attempt === currentStep?.attempt
      ? supplementalInput
      : null;
  const requestedChanges =
    latestReview?.status === "changes_requested" && latestReview.note.trim()
      ? `REQUESTED CHANGES\n${latestReview.note.trim()}\nRevise the current deliverables to address this review note. Preserve prior work that is not affected, keep source citations attached to material facts, and do not imply approval.`
      : "";
  const deliverables = requiredTaskDeliverables(snapshot.task).map(
    (deliverable) =>
      `- ${deliverable.title ?? taskDeliverablePurpose(deliverable)}: ${deliverable.artifact_type} (${taskDeliverablePurpose(deliverable)})`,
  );
  const creationKind = agentStepCreationKind(currentStep ?? {});
  const creationInstruction =
    creationKind === "tabular_review"
      ? "Create exactly the declared Excel deliverable for this step with generate_excel. Do not create a Word document or any undeclared output."
      : creationKind === "draft"
        ? "Create exactly the declared Word deliverable for this step with generate_docx. Do not create a spreadsheet or any undeclared output."
        : "Read or analyze only for this step. Do not call document-generation tools and do not create artifacts; return a concise checkpoint for the next step.";
  return [
    `WORK TASK GOAL\n${snapshot.task.goal}`,
    `CURRENT STEP\n${currentStep?.title ?? "Complete the current step"}\nExpected output: ${currentStep?.expected_output ?? "Complete the requested work."}`,
    deliverables.length
      ? `REQUIRED DELIVERABLES\n${deliverables.join("\n")}`
      : "REQUIRED DELIVERABLES\nNone declared.",
    workflowInstruction ? `SELECTED MIKE WORKFLOW\n${workflowInstruction}` : "",
    currentSupplement
      ? [
          "USER SUPPLEMENTAL INPUT FOR THIS STEP",
          currentSupplement.message ||
            "No text response; use the newly attached Matter documents.",
          currentSupplement.document_ids.length
            ? `${currentSupplement.document_ids.length} Matter document${currentSupplement.document_ids.length === 1 ? " was" : "s were"} added with this response.`
            : "No new documents were attached with this response.",
          "Use this only to resolve the current blocked step. It does not change the task goal, permissions, review requirements, or export gate.",
        ].join("\n")
      : "",
    requestedChanges,
    completed.length
      ? `COMPLETED STEP CHECKPOINTS\n${completed.join("\n")}`
      : "",
    artifactManifest.length
      ? `LINKED ARTIFACTS\n${artifactManifest.join("\n")}`
      : "LINKED ARTIFACTS\nNone yet.",
    currentStep?.title === "Verify deliverables"
      ? "Verify: (1) the user goal is covered, (2) every declared deliverable exists in this Matter, (3) important factual statements are source-backed when sources were selected, (4) citations can be relocated, and (5) no prior step is incomplete or failed. Do not create a deliverable. Return PASS or GAP for every check."
      : `Complete only this step. ${creationInstruction} Keep the saved checkpoint concise.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function getOrCreateTaskChat(
  db: Db,
  snapshot: NonNullable<TaskSnapshot>,
  userId: string,
) {
  const linked = snapshot.artifacts.find(
    (artifact) => artifact.artifact_type === "chat",
  );
  if (linked) return linked.artifact_id;
  const { data, error } = await db
    .from("chats")
    .insert({
      user_id: userId,
      project_id: snapshot.task.matter_id,
      title: `Work: ${snapshot.task.goal.slice(0, 110)}`,
    })
    .select("id")
    .single();
  if (error || !data)
    throw new Error(error?.message ?? "Failed to create task chat");
  await addAgentArtifactLinks(db, snapshot.task.id, [
    {
      artifact_type: "chat",
      artifact_id: data.id,
      purpose: "Task execution record",
    },
  ]);
  return data.id as string;
}

export type AgentStepExecutionResult = {
  summary: string;
  artifacts: AgentArtifactLinkInput[];
  waitingForInput: boolean;
  requiredInput?: AgentRequiredInputV1 | null;
  citationCheck: { total: number; relocatable: number; missing: number };
  verification?: {
    packet: AgentVerificationPacketV1;
    result: AgentVerificationResultV1;
  } | null;
};

type RelocatedCitation = {
  document_id: string | null;
  status: "exact" | "drifted" | "missing" | "version_mismatch";
};

export function summarizeTaskCitationRelocation(
  citations: RelocatedCitation[],
  sourceIds: string[],
  unavailableSnapshots = 0,
) {
  const sourceBacked = citations.some(
    (citation) =>
      citation.document_id !== null && sourceIds.includes(citation.document_id),
  );
  const relocatable = citations.filter(
    (citation) =>
      citation.status === "exact" &&
      citation.document_id !== null &&
      sourceIds.includes(citation.document_id),
  ).length;
  const total = citations.length + unavailableSnapshots;
  const missing = total === 0 ? 0 : sourceBacked ? total - relocatable : total;
  return {
    total,
    relocatable,
    missing,
  };
}

export async function verifyTaskCitationLinks(
  db: Db,
  snapshot: NonNullable<TaskSnapshot>,
  userId: string,
) {
  const sourceIds = snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.artifact_type === "document" &&
        artifact.purpose === "Source document",
    )
    .map((artifact) => artifact.artifact_id);
  const messageIds = snapshot.artifacts
    .filter((artifact) => artifact.artifact_type === "citation_snapshot")
    .map((artifact) => artifact.artifact_id);
  if (!messageIds.length) return { total: 0, relocatable: 0, missing: 0 };
  const snapshots = await Promise.all(
    messageIds.map((artifactId) =>
      getAgentTaskEvidence(db, {
        taskId: snapshot.task.id,
        artifactId,
        userId,
      }),
    ),
  );
  const citations = snapshots.flatMap((evidence) => evidence?.citations ?? []);
  const unavailableSnapshots = snapshots.filter(
    (evidence) => evidence === null,
  ).length;
  return summarizeTaskCitationRelocation(
    citations,
    sourceIds,
    unavailableSnapshots,
  );
}

export function isTransientModelError(error: unknown) {
  if (error && typeof error === "object") {
    const row = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    if (
      [row.status, row.statusCode, row.response?.status].some(
        (status) => status === 429 || status === 503,
      )
    ) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|\b503\b|overloaded|queue|temporarily unavailable|resource exhausted|timed out|fetch failed|econnreset|etimedout|enetunreach|eai_again|socket hang up/i.test(
    message,
  );
}

function queueRetryAttempts(selectedModel: string) {
  if (providerForModel(selectedModel) === "gemini") {
    return [
      { model: selectedModel, waitMs: 0 },
      { model: selectedModel, waitMs: 1200 },
      {
        model:
          selectedModel === "gemini-3-flash-preview"
            ? "gemini-3.5-flash"
            : selectedModel,
        waitMs: 2200,
      },
    ];
  }
  return [
    { model: selectedModel, waitMs: 0 },
    { model: selectedModel, waitMs: 1200 },
    { model: selectedModel, waitMs: 2200 },
  ];
}

async function runStepWithQueueRetry(
  args: Parameters<typeof runLLMStream>[0],
  selectedModel: string,
  shouldContinue?: () => Promise<boolean>,
) {
  const attempts = queueRetryAttempts(selectedModel);
  let lastError: unknown;
  for (const attempt of attempts) {
    if (shouldContinue && !(await shouldContinue())) {
      throw new AgentTaskExecutionInterruptedError();
    }
    if (attempt.waitMs) {
      await new Promise((resolve) => setTimeout(resolve, attempt.waitMs));
      if (shouldContinue && !(await shouldContinue())) {
        throw new AgentTaskExecutionInterruptedError();
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    try {
      return await runLLMStream({
        ...args,
        model: attempt.model,
        signal: controller.signal,
      });
    } catch (error) {
      const normalized = controller.signal.aborted
        ? new Error(`Model request timed out while using ${attempt.model}`)
        : error;
      lastError = normalized;
      if (!isTransientModelError(normalized)) throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export class AgentTaskExecutionInterruptedError extends Error {
  constructor() {
    super("Agent task execution was paused or blocked");
    this.name = "AgentTaskExecutionInterruptedError";
  }
}

export function isAgentTaskExecutionInterrupted(error: unknown) {
  return error instanceof AgentTaskExecutionInterruptedError;
}

function artifactFromCreatedEvent(
  event: Extract<AssistantEvent, { type: "doc_created" }>,
  snapshot: NonNullable<TaskSnapshot>,
  allowReplacement: boolean,
  stepContract?: AgentStepContractV1 | null,
): AgentArtifactLinkInput | null {
  if (!event.document_id) return null;
  const filename = event.filename.toLowerCase();
  const artifactType =
    filename.endsWith(".xlsx") || filename.endsWith(".xls")
      ? "tabular_review"
      : filename.endsWith(".docx")
        ? "draft"
        : "document";
  if (stepContract) {
    const expectation = stepContract.output_expectation;
    if (expectation.kind !== "artifact") {
      throw new Error("A non-artifact Step created an undeclared document");
    }
    if (artifactType !== expectation.artifact_type) {
      throw new Error("Created document type does not match the Step Contract");
    }
    const deliverable = requiredTaskDeliverables(snapshot.task).find(
      (candidate) => candidate.key === expectation.deliverable_key,
    );
    if (!deliverable) {
      throw new Error("Step Contract deliverable is not declared by the Task");
    }
    return {
      artifact_type: artifactType,
      artifact_id: event.document_id,
      purpose: taskDeliverablePurpose(deliverable),
    };
  }
  const typedDeliverables = requiredTaskDeliverables(snapshot.task).filter(
    (candidate) => candidate.artifact_type === artifactType,
  );
  const deliverable =
    typedDeliverables.find(
      (candidate) => !findDeliverableArtifact(candidate, snapshot.artifacts),
    ) ?? (allowReplacement ? typedDeliverables[0] : undefined);
  if (deliverable) {
    return {
      artifact_type: artifactType,
      artifact_id: event.document_id,
      purpose: taskDeliverablePurpose(deliverable),
    };
  }
  return {
    artifact_type: artifactType,
    artifact_id: event.document_id,
    purpose:
      artifactType === "tabular_review"
        ? "Generated table"
        : artifactType === "draft"
          ? "Generated draft"
          : "Generated document",
  };
}

export async function executeAgentStep(input: {
  db: Db;
  snapshot: NonNullable<TaskSnapshot>;
  userId: string;
  userEmail?: string;
  instructionOverride?: string;
  repairArtifactPurpose?: string;
  shouldContinue?: () => Promise<boolean>;
}): Promise<AgentStepExecutionResult> {
  const { db, snapshot, userId, userEmail } = input;
  const stepIndex = snapshot.task.current_plan.findIndex(
    (step: { status: string }) => step.status === "running",
  );
  if (stepIndex < 0) throw new Error("Running task has no executable step");
  const stepContractRead = readAgentStepContracts(snapshot.task);
  if (stepContractRead.state === "invalid") {
    throw new Error(`Step Contract is invalid: ${stepContractRead.reason}`);
  }
  const stepContract =
    stepContractRead.state === "valid"
      ? (stepContractRead.contracts[stepIndex] ?? null)
      : null;
  if (stepContractRead.state === "valid" && !stepContract) {
    throw new Error("Running Step has no fixed Step Contract");
  }
  const grantRead = readAgentStepCapabilityGrants(snapshot.task);
  if (grantRead.state === "invalid") {
    throw new Error(`Capability Grant is invalid: ${grantRead.reason}`);
  }
  const capabilityGrant =
    grantRead.state === "valid" ? (grantRead.grants[stepIndex] ?? null) : null;
  if (
    stepContract &&
    (!capabilityGrant ||
      capabilityGrant.step_position !== stepContract.position ||
      capabilityGrant.capability !== stepContract.capability ||
      capabilityGrant.operation !== stepContract.operation)
  ) {
    throw new Error("Capability Grant does not match the fixed Step Contract");
  }

  const sourceIds = snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.artifact_type === "document" &&
        artifact.purpose === "Source document",
    )
    .map((artifact) => artifact.artifact_id);
  const fixedMatterContext = readFixedMatterContext(snapshot.task);
  if (fixedMatterContext) {
    const fixedIds = fixedMatterContext.sources.map(
      (source) => source.document_id,
    );
    if (
      fixedIds.length !== sourceIds.length ||
      fixedIds.some((documentId) => !sourceIds.includes(documentId))
    ) {
      throw new MatterContextInvalidError(
        "matter_context_scope_mismatch",
        "Linked task sources do not match the fixed Matter context.",
        { fixed_document_ids: fixedIds, linked_document_ids: sourceIds },
      );
    }
  }
  const currentStep = snapshot.task.current_plan[stepIndex];
  const selectedWorkflow = snapshot.artifacts.find(
    (artifact) =>
      artifact.artifact_type === "workflow_run" &&
      artifact.purpose.startsWith("Selected workflow:"),
  );
  const goalProfile = inferGoalProfile(
    snapshot.task.goal,
    selectedWorkflow?.artifact_id,
  );
  const sourceDependentGoal =
    ["contract_review", "compare", "extract", "proofread"].includes(
      goalProfile,
    ) || currentStep?.capability === "read_sources";
  if (
    sourceIds.length === 0 &&
    sourceDependentGoal &&
    currentStep?.title !== "Verify deliverables"
  ) {
    return {
      summary: "Source documents are required before this step can run.",
      artifacts: [],
      waitingForInput: true,
      requiredInput: createDocumentsRequiredInput({
        stepId: currentStep.id,
      }),
      citationCheck: { total: 0, relocatable: 0, missing: 0 },
    };
  }

  const { data: sourceRows, error: sourceError } =
    fixedMatterContext || !sourceIds.length
      ? { data: [], error: null }
      : sourceIds.length
        ? await db.from("documents").select("id").in("id", sourceIds)
        : { data: [], error: null };
  if (sourceError) throw new Error(sourceError.message);
  const sourceFiles = fixedMatterContext
    ? fixedMatterContext.sources.map((source) => ({
        filename: source.filename,
        document_id: source.document_id,
        version_id: source.version_id,
      }))
    : (sourceRows ?? []).map((row) => ({
        filename: `Matter document ${row.id}`,
        document_id: row.id as string,
      }));

  const chatId = await getOrCreateTaskChat(db, snapshot, userId);
  const workflowConstraint = fixedMatterContext
    ? fixedMatterContext.workflow
    : selectedWorkflow
      ? await resolveAgentWorkflowConstraint({
          db,
          workflowId: selectedWorkflow.artifact_id,
          userId,
          userEmail,
        })
      : null;
  const workflowInstruction = workflowConstraint
    ? [
        `${workflowConstraint.title}: ${workflowConstraint.description}`,
        workflowConstraint.instructions.slice(0, 8_000),
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
  let prompt = input.instructionOverride
    ? `${taskPrompt(
        snapshot,
        stepIndex,
        snapshot.artifacts.map(
          (artifact) =>
            `- ${artifact.purpose}: ${artifact.artifact_type}/${artifact.artifact_id}`,
        ),
        workflowInstruction,
      )}\n\nREPAIR INSTRUCTION\n${input.instructionOverride}`
    : taskPrompt(
        snapshot,
        stepIndex,
        snapshot.artifacts.map(
          (artifact) =>
            `- ${artifact.purpose}: ${artifact.artifact_type}/${artifact.artifact_id}`,
        ),
        workflowInstruction,
      );
  const repairPass = Boolean(
    input.instructionOverride?.startsWith(
      "This is the single permitted repair pass",
    ),
  );
  const repairDeliverable = repairPass
    ? requiredTaskDeliverables(snapshot.task).find(
        (deliverable) =>
          taskDeliverablePurpose(deliverable) === input.repairArtifactPurpose,
      )
    : null;
  if (repairPass && !repairDeliverable) {
    throw new Error(
      "A verifier repair requires one uniquely bound declared deliverable",
    );
  }
  const verifierOnly =
    (stepContract?.capability === "verify" ||
      snapshot.task.status === "verifying") &&
    !repairPass;
  const verifierCitationCheck =
    verifierOnly && stepContract
      ? await verifyTaskCitationLinks(db, snapshot, userId)
      : null;
  const verificationPacket =
    verifierOnly && stepContract
      ? await buildCurrentAgentVerificationPacket({
          db,
          snapshot,
          userId,
          stepId: currentStep.id,
          stepAttempt: currentStep.attempt,
          profile: {
            kind: "agent_verifier_profile_v1",
            id: "generic-current-artifact",
            version: "1",
            semantic_goal_check: true,
            repair_policy: "none",
          },
          citationsRequired:
            stepContract?.source_requirement.citations_required ?? false,
          citationCoverage: verifierCitationCheck ?? {
            total: 0,
            relocatable: 0,
            missing: 0,
          },
        })
      : null;
  if (verificationPacket) {
    prompt = [
      "Verify only whether each current accepted-view deliverable answers the fixed WORK TASK GOAL.",
      "The server has already decided every Artifact, Matter, current-Version, accepted-view, source, citation, locator, and prior-Step fact in deterministic_checks. Do not add, remove, repeat, or override those facts.",
      "Report only a material goal omission. Every omission must name one declared deliverable_key and quote one exact, contiguous goal_excerpt from the fixed goal. Do not infer a requirement from a source, template, precedent, or your own legal judgment.",
      'Return exactly one JSON object and no commentary: {"kind":"agent_semantic_verifier_result_v1","goal_coverage":"pass","issues":[]}. For a real omission, goal_coverage is gap and each issue contains only code=semantic_goal_omission, deliverable_key, goal_excerpt, and detail.',
      `VERIFICATION PACKET\n${JSON.stringify(verificationPacket)}`,
    ].join("\n\n");
  }
  const activeSourceFiles = verifierOnly ? [] : sourceFiles;
  const userMessage: ChatMessage = {
    role: "user",
    content: prompt,
    files: activeSourceFiles,
    ...(workflowConstraint
      ? {
          workflow: {
            id: workflowConstraint.id,
            title: workflowConstraint.title,
          },
        }
      : {}),
  };
  const { error: userMessageError } = await db.from("chat_messages").insert({
    chat_id: chatId,
    role: "user",
    content: prompt,
    files: activeSourceFiles.length ? activeSourceFiles : null,
  });
  if (userMessageError) throw new Error(userMessageError.message);

  const { docIndex, docStore } = await buildDocContext(
    [userMessage],
    userId,
    db,
    verifierOnly ? null : chatId,
  );
  const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
    doc_id,
    filename: info.filename,
  }));
  const apiMessages = buildMessages(
    [userMessage],
    docAvailability,
    verificationPacket
      ? "You are Vera's bounded semantic verifier. Use only the fixed goal and the current accepted-view deliverables in the supplied packet. Return the exact JSON contract without tools or commentary. You cannot decide source, citation, locator, Version, approval, or export facts."
      : verifierOnly
        ? "You are the final Vera verifier. Use only the goal, declared deliverables, saved checkpoints, and artifact manifest. Do not call tools or create documents. Return PASS or GAP for goal coverage, required Matter outputs, source support, citation relocation, and step completion. Never imply lawyer approval."
        : "You are executing one bounded step in a Vera legal Work Task. Preserve source boundaries, never imply lawyer approval, and use the existing Mike tools when the step requires a document artifact.",
    docIndex,
    false,
  );
  const [{ api_keys: apiKeys }, workflowStore] = await Promise.all([
    getUserModelSettings(userId, db),
    buildWorkflowStore(userId, userEmail, db),
  ]);
  const executionModel =
    typeof snapshot.task.execution_model === "string" &&
    snapshot.task.execution_model
      ? snapshot.task.execution_model
      : DEFAULT_MAIN_MODEL;
  const mutationReceipts = new Map<string, AgentStepEffectReceiptV1>();
  const expectedMutation = repairPass
    ? repairDeliverable?.artifact_type === "tabular_review"
      ? ({
          toolName: "generate_excel",
          artifactType: "tabular_review",
        } as const)
      : ({ toolName: "generate_docx", artifactType: "draft" } as const)
    : stepContract?.output_expectation.kind === "artifact"
      ? stepContract.output_expectation.artifact_type === "tabular_review"
        ? ({
            toolName: "generate_excel",
            artifactType: "tabular_review",
          } as const)
        : ({ toolName: "generate_docx", artifactType: "draft" } as const)
      : null;
  const authorizeToolBatch = stepContract
    ? async (calls: ToolInvocation[]) => {
        const mutations = calls.filter(
          (call): call is ToolInvocation & { name: AgentStepMutationTool } =>
            call.name === "generate_docx" || call.name === "generate_excel",
        );
        if (mutations.length > 1) {
          throw new Error(
            "A versioned Step may create at most one document per tool batch",
          );
        }
        for (const call of mutations) {
          if (!expectedMutation || call.name !== expectedMutation.toolName) {
            throw new Error(
              "Document generation does not match the fixed Step output",
            );
          }
          const mechanicallyValid =
            call.name === "generate_docx"
              ? isValidGenerateDocxInput(call.input)
              : isValidGenerateExcelInput(call.input);
          if (!mechanicallyValid) continue;
          const wanted = buildAgentStepEffectReservation({
            stepId: currentStep.id,
            attempt: currentStep.attempt,
            toolName: call.name,
            toolInput: call.input,
          });
          const receipt = await reserveAgentStepEffect(db, {
            taskId: snapshot.task.id,
            receipt: wanted,
          });
          mutationReceipts.set(call.id, receipt);
        }
      }
    : undefined;
  const finalizeToolBatch = stepContract
    ? async (
        calls: ToolInvocation[],
        outcome: {
          createdDocuments: Array<{
            document_id?: string;
            version_id?: string;
            filename: string;
          }>;
        },
      ) => {
        const mutations = calls.filter(
          (call) =>
            call.name === "generate_docx" || call.name === "generate_excel",
        );
        if (!mutations.length) return;
        const receipt = mutationReceipts.get(mutations[0].id);
        const created = outcome.createdDocuments;
        if (!receipt && created.length === 0) return;
        if (
          !receipt ||
          created.length !== 1 ||
          !created[0].document_id ||
          !created[0].version_id ||
          created[0].document_id !== receipt.target.document_id ||
          created[0].version_id !== receipt.target.version_id ||
          !expectedMutation
        ) {
          throw new Error(
            "Generated document did not match the reserved Step effect",
          );
        }
        await commitAgentStepEffect(db, {
          taskId: snapshot.task.id,
          receipt,
          artifactType: expectedMutation.artifactType,
          documentId: created[0].document_id,
          versionId: created[0].version_id,
        });
      }
    : undefined;
  const streamArgs: Parameters<typeof runLLMStream>[0] = {
    apiMessages,
    docStore,
    docIndex,
    userId,
    db,
    write: () => {},
    workflowStore,
    includeResearchTools: false,
    includeMcpTools: stepContract ? false : true,
    disableTools: verifierOnly,
    ...(repairPass && repairDeliverable
      ? {
          allowedToolNames: resolveBoundedRepairToolNames({
            artifactType:
              repairDeliverable.artifact_type === "tabular_review"
                ? "tabular_review"
                : "draft",
            availableToolNames: WORK_TASK_HOST_TOOL_NAMES,
          }),
        }
      : stepContract
        ? {
            allowedToolNames: capabilityGrant?.allowed_tool_names ?? [],
          }
        : {}),
    apiKeys,
    projectId: snapshot.task.matter_id,
    beforeToolBatch: input.shouldContinue
      ? async () => {
          if (!(await input.shouldContinue?.())) {
            throw new AgentTaskExecutionInterruptedError();
          }
        }
      : undefined,
    authorizeToolBatch,
    mutationTargetForCall: stepContract
      ? (call) => {
          const receipt = mutationReceipts.get(call.id);
          return receipt
            ? {
                documentId: receipt.target.document_id,
                versionId: receipt.target.version_id,
              }
            : null;
        }
      : undefined,
    finalizeToolBatch,
  };
  let streamResult = await runStepWithQueueRetry(
    streamArgs,
    executionModel,
    input.shouldContinue,
  );
  let semanticVerification = verificationPacket
    ? (() => {
        const text = streamResult.events
          .filter(
            (event): event is Extract<typeof event, { type: "content" }> =>
              event.type === "content",
          )
          .map((event) => event.text)
          .join("\n")
          .trim();
        try {
          return parseAgentSemanticVerifierResult(
            text || streamResult.fullText,
          );
        } catch {
          return null;
        }
      })()
    : null;
  if (verificationPacket && !semanticVerification) {
    const invalid = streamResult.events
      .filter(
        (event): event is Extract<typeof event, { type: "content" }> =>
          event.type === "content",
      )
      .map((event) => event.text)
      .join("\n")
      .trim();
    streamResult = await runStepWithQueueRetry(
      {
        ...streamArgs,
        apiMessages: [
          ...apiMessages,
          { role: "assistant", content: invalid || streamResult.fullText },
          {
            role: "user",
            content:
              "Your verifier response did not match the exact JSON contract. Return one corrected agent_semantic_verifier_result_v1 object only. Do not add commentary, source facts, citation facts, Version facts, approval, or export state.",
          },
        ],
      },
      executionModel,
      input.shouldContinue,
    );
    const repairedText = streamResult.events
      .filter(
        (event): event is Extract<typeof event, { type: "content" }> =>
          event.type === "content",
      )
      .map((event) => event.text)
      .join("\n")
      .trim();
    semanticVerification = parseAgentSemanticVerifierResult(
      repairedText || streamResult.fullText,
    );
  }
  const { fullText, events, citations } = streamResult;
  const persistedEvents = stripTransientAssistantEvents(events);
  const { data: assistantMessage, error: assistantError } = await db
    .from("chat_messages")
    .insert({
      chat_id: chatId,
      role: "assistant",
      content: persistedEvents.length ? persistedEvents : null,
      citations: citations.length ? citations : null,
    })
    .select("id")
    .single();
  if (assistantError || !assistantMessage) {
    throw new Error(
      assistantError?.message ?? "Failed to save task step result",
    );
  }

  const artifacts: AgentArtifactLinkInput[] = persistedEvents.flatMap(
    (event) => {
      if (event.type !== "doc_created") return [];
      const artifact = artifactFromCreatedEvent(
        event,
        snapshot,
        repairPass,
        repairPass ? null : stepContract,
      );
      if (!artifact) return [];
      if (repairPass) {
        const expectedArtifactType =
          repairDeliverable!.artifact_type === "tabular_review"
            ? "tabular_review"
            : "draft";
        if (artifact.artifact_type !== expectedArtifactType) {
          throw new Error(
            "A bounded verifier repair created the wrong document type",
          );
        }
      }
      if (
        repairPass &&
        artifact.purpose !== taskDeliverablePurpose(repairDeliverable!)
      ) {
        return [
          {
            ...artifact,
            purpose: taskDeliverablePurpose(repairDeliverable!),
          },
        ];
      }
      return [artifact];
    },
  );
  if (
    repairPass &&
    artifacts.filter((artifact) =>
      ["draft", "tabular_review", "document"].includes(artifact.artifact_type),
    ).length > 1
  ) {
    throw new Error("A bounded verifier repair created more than one document");
  }
  if (citations.length) {
    artifacts.push({
      artifact_type: "citation_snapshot",
      artifact_id: assistantMessage.id as string,
      purpose: `Step ${stepIndex + 1} evidence citations`,
    });
  }
  const requiredInput = requiredInputFromAssistantEvents(persistedEvents, {
    stepId: currentStep.id,
    resolvedRequestIds: readResolvedRequiredInputIds(
      snapshot.task.latest_checkpoint,
    ),
  });
  const waitingForInput = Boolean(requiredInput);
  const contentText = persistedEvents
    .filter(
      (event): event is Extract<typeof event, { type: "content" }> =>
        event.type === "content",
    )
    .map((event) => event.text)
    .join("\n")
    .trim();
  const verification = verificationPacket
    ? {
        packet: verificationPacket,
        result: mergeAgentVerificationResultV1({
          packet: verificationPacket,
          semanticResult: semanticVerification!,
        }),
      }
    : null;
  const summary = verification
    ? verification.result.outcome === "clean_pass"
      ? "Automated verification found no deterministic or fixed-goal gap. Lawyer review is still required before approval or export."
      : `Automated verification preserved the current deliverables and found ${verification.result.issues.length} review gap(s): ${verification.result.issues
          .map((issue) => issue.detail)
          .join("; ")}`
    : contentText || fullText || `Step ${stepIndex + 1} completed.`;
  return {
    summary: summary.slice(0, 4000),
    artifacts,
    waitingForInput,
    requiredInput,
    citationCheck: verifierCitationCheck ?? {
      total: citations.length,
      relocatable: citations.filter((citation) => {
        if (!citation || typeof citation !== "object") return false;
        const row = citation as Record<string, unknown>;
        return (
          typeof row.document_id === "string" &&
          sourceIds.includes(row.document_id) &&
          typeof row.version_id === "string" &&
          typeof row.quote === "string" &&
          row.quote.trim().length > 0
        );
      }).length,
      missing: citations.filter((citation) => {
        if (!citation || typeof citation !== "object") return true;
        const row = citation as Record<string, unknown>;
        return !(
          typeof row.document_id === "string" &&
          sourceIds.includes(row.document_id) &&
          typeof row.version_id === "string" &&
          typeof row.quote === "string" &&
          row.quote.trim().length > 0
        );
      }).length,
    },
    verification,
  };
}
