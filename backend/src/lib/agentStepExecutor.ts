import {
  buildDocContext,
  buildMessages,
  buildWorkflowStore,
  runLLMStream,
  stripTransientAssistantEvents,
  type AssistantEvent,
  type ChatMessage,
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
  citationCheck: { total: number; relocatable: number; missing: number };
};

export async function verifyTaskCitationLinks(
  db: Db,
  snapshot: NonNullable<TaskSnapshot>,
) {
  const sourceIds = snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.artifact_type === "document" &&
        artifact.purpose === "Source document",
    )
    .map((artifact) => artifact.artifact_id);
  const allowedDocumentIds = Array.from(
    new Set(
      snapshot.artifacts
        .filter((artifact) =>
          ["document", "draft", "tabular_review"].includes(
            artifact.artifact_type,
          ),
        )
        .map((artifact) => artifact.artifact_id),
    ),
  );
  const messageIds = snapshot.artifacts
    .filter((artifact) => artifact.artifact_type === "citation_snapshot")
    .map((artifact) => artifact.artifact_id);
  if (!messageIds.length) return { total: 0, relocatable: 0, missing: 0 };
  const [
    { data: messages, error: messageError },
    { data: documents, error: documentError },
  ] = await Promise.all([
    db.from("chat_messages").select("id,citations").in("id", messageIds),
    db
      .from("documents")
      .select("id,current_version_id")
      .in("id", allowedDocumentIds),
  ]);
  if (messageError) throw new Error(messageError.message);
  if (documentError) throw new Error(documentError.message);
  const currentVersions = new Map(
    (documents ?? []).map((document) => [
      document.id as string,
      document.current_version_id as string | null,
    ]),
  );
  const citations: unknown[] = [];
  for (const message of messages ?? []) {
    const original = Array.isArray(message.citations) ? message.citations : [];
    let changed = false;
    const normalized = original.map((citation) => {
      if (!citation || typeof citation !== "object") return citation;
      const row = citation as Record<string, unknown>;
      const documentId =
        typeof row.document_id === "string" ? row.document_id : null;
      const currentVersionId = documentId
        ? currentVersions.get(documentId)
        : null;
      if (
        documentId &&
        currentVersionId &&
        typeof row.version_id !== "string"
      ) {
        changed = true;
        return { ...row, version_id: currentVersionId };
      }
      return citation;
    });
    if (changed) {
      const { error: updateError } = await db
        .from("chat_messages")
        .update({ citations: normalized })
        .eq("id", message.id);
      if (updateError) throw new Error(updateError.message);
    }
    citations.push(...normalized);
  }
  const relocatable = citations.filter((citation) => {
    if (!citation || typeof citation !== "object") return false;
    const row = citation as Record<string, unknown>;
    const documentId =
      typeof row.document_id === "string" ? row.document_id : null;
    return Boolean(
      documentId &&
      allowedDocumentIds.includes(documentId) &&
      typeof row.version_id === "string" &&
      currentVersions.get(documentId) === row.version_id &&
      typeof row.quote === "string" &&
      row.quote.trim(),
    );
  }).length;
  const sourceBacked = citations.filter((citation) => {
    if (!citation || typeof citation !== "object") return false;
    const row = citation as Record<string, unknown>;
    return (
      typeof row.document_id === "string" && sourceIds.includes(row.document_id)
    );
  }).length;
  return {
    total: citations.length,
    relocatable,
    missing: citations.length - relocatable + (sourceBacked > 0 ? 0 : 1),
  };
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
): AgentArtifactLinkInput | null {
  if (!event.document_id) return null;
  const filename = event.filename.toLowerCase();
  const artifactType =
    filename.endsWith(".xlsx") || filename.endsWith(".xls")
      ? "tabular_review"
      : filename.endsWith(".docx")
        ? "draft"
        : "document";
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
  shouldContinue?: () => Promise<boolean>;
}): Promise<AgentStepExecutionResult> {
  const { db, snapshot, userId, userEmail } = input;
  const stepIndex = snapshot.task.current_plan.findIndex(
    (step: { status: string }) => step.status === "running",
  );
  if (stepIndex < 0) throw new Error("Running task has no executable step");

  const sourceIds = snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.artifact_type === "document" &&
        artifact.purpose === "Source document",
    )
    .map((artifact) => artifact.artifact_id);
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
      citationCheck: { total: 0, relocatable: 0, missing: 0 },
    };
  }

  const { data: sourceRows, error: sourceError } = sourceIds.length
    ? await db.from("documents").select("id").in("id", sourceIds)
    : { data: [], error: null };
  if (sourceError) throw new Error(sourceError.message);
  const sourceFiles = (sourceRows ?? []).map((row) => ({
    filename: `Matter document ${row.id}`,
    document_id: row.id as string,
  }));

  const chatId = await getOrCreateTaskChat(db, snapshot, userId);
  const workflowConstraint = selectedWorkflow
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
  const prompt = input.instructionOverride
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
  const verifierOnly =
    snapshot.task.status === "verifying" &&
    !input.instructionOverride?.startsWith(
      "This is the single permitted repair pass",
    );
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
    verifierOnly
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
  const { fullText, events, citations } = await runStepWithQueueRetry(
    {
      apiMessages,
      docStore,
      docIndex,
      userId,
      db,
      write: () => {},
      workflowStore,
      includeResearchTools: false,
      disableTools: verifierOnly,
      apiKeys,
      projectId: snapshot.task.matter_id,
      beforeToolBatch: input.shouldContinue
        ? async () => {
            if (!(await input.shouldContinue?.())) {
              throw new AgentTaskExecutionInterruptedError();
            }
          }
        : undefined,
    },
    executionModel,
    input.shouldContinue,
  );
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
        Boolean(input.instructionOverride),
      );
      return artifact ? [artifact] : [];
    },
  );
  if (citations.length) {
    artifacts.push({
      artifact_type: "citation_snapshot",
      artifact_id: assistantMessage.id as string,
      purpose: `Step ${stepIndex + 1} evidence citations`,
    });
  }
  const waitingForInput = persistedEvents.some(
    (event) => event.type === "ask_inputs",
  );
  const contentText = persistedEvents
    .filter(
      (event): event is Extract<typeof event, { type: "content" }> =>
        event.type === "content",
    )
    .map((event) => event.text)
    .join("\n")
    .trim();
  return {
    summary: (
      contentText ||
      fullText ||
      `Step ${stepIndex + 1} completed.`
    ).slice(0, 4000),
    artifacts,
    waitingForInput,
    citationCheck: {
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
  };
}
