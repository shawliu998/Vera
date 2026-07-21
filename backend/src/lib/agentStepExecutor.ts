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
  type AgentArtifactLinkInput,
} from "./agentTasks";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";
import { DEFAULT_MAIN_MODEL, providerForModel } from "./llm";

type Db = ReturnType<typeof createServerSupabase>;

type TaskSnapshot = Awaited<
  ReturnType<typeof import("./agentTasks").getAgentTaskSnapshot>
>;

const STEP_INSTRUCTIONS = [
  "Read every attached source document. Return a concise source manifest and identify any document that could not be read. Do not draft the deliverables yet.",
  "Read every attached source document. Extract verified facts and contract positions. Separate verified facts, analysis, and open questions. Do not treat an inference as a fact.",
  "Read every attached source document, then create the required risk matrix. You MUST call generate_excel. Use columns: Issue, Clause or location, Verified fact, Risk, Recommendation, Source. Flag any unresolved conclusion for lawyer review.",
  "Read every attached source document, then create the required review memo. You MUST call generate_docx. Use separate sections for Verified facts, Analysis, Recommendations, Open questions, and Lawyer review status. Support material factual statements with citations.",
  "Verify the complete work task. Check exactly: (1) required deliverables exist, (2) important facts have sources, (3) facts, analysis, and recommendations are distinct, and (4) there is no obvious omission or contradiction. Do not create a new deliverable. State PASS or GAP for each check and identify any required repair.",
] as const;

function taskPrompt(
  snapshot: NonNullable<TaskSnapshot>,
  stepIndex: number,
  artifactManifest: string[],
) {
  const completed = snapshot.task.current_plan
    .filter((step: { status: string }) => step.status === "completed")
    .map(
      (step: { title: string; result_summary: string | null }) =>
        `- ${step.title}: ${step.result_summary ?? "Completed"}`,
    );
  return [
    `WORK TASK GOAL\n${snapshot.task.goal}`,
    `CURRENT STEP\n${STEP_INSTRUCTIONS[stepIndex] ?? snapshot.task.current_plan[stepIndex]?.expected_output}`,
    completed.length
      ? `COMPLETED STEP CHECKPOINTS\n${completed.join("\n")}`
      : "",
    artifactManifest.length
      ? `LINKED ARTIFACTS\n${artifactManifest.join("\n")}`
      : "LINKED ARTIFACTS\nNone yet.",
    "Complete only this step. Keep the output concise enough to serve as the saved checkpoint.",
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
) {
  const attempts = queueRetryAttempts(selectedModel);
  let lastError: unknown;
  for (const attempt of attempts) {
    if (attempt.waitMs) {
      await new Promise((resolve) => setTimeout(resolve, attempt.waitMs));
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

function artifactFromCreatedEvent(
  event: Extract<AssistantEvent, { type: "doc_created" }>,
  stepIndex: number,
): AgentArtifactLinkInput | null {
  if (!event.document_id) return null;
  const filename = event.filename.toLowerCase();
  if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
    return {
      artifact_type: "tabular_review",
      artifact_id: event.document_id,
      purpose: "Risk matrix",
    };
  }
  if (filename.endsWith(".docx") || stepIndex === 3) {
    return {
      artifact_type: "draft",
      artifact_id: event.document_id,
      purpose: "Review memo draft",
    };
  }
  return {
    artifact_type: "document",
    artifact_id: event.document_id,
    purpose: "Generated document",
  };
}

export async function executeAgentStep(input: {
  db: Db;
  snapshot: NonNullable<TaskSnapshot>;
  userId: string;
  userEmail?: string;
  instructionOverride?: string;
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
  if (sourceIds.length === 0 && stepIndex < 4) {
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
  const prompt = input.instructionOverride
    ? `${taskPrompt(
        snapshot,
        stepIndex,
        snapshot.artifacts.map(
          (artifact) =>
            `- ${artifact.purpose}: ${artifact.artifact_type}/${artifact.artifact_id}`,
        ),
      )}\n\nREPAIR INSTRUCTION\n${input.instructionOverride}`
    : taskPrompt(
        snapshot,
        stepIndex,
        snapshot.artifacts.map(
          (artifact) =>
            `- ${artifact.purpose}: ${artifact.artifact_type}/${artifact.artifact_id}`,
        ),
      );
  const verifierOnly =
    stepIndex === 4 &&
    !input.instructionOverride?.startsWith(
      "This is the single permitted repair pass",
    );
  const activeSourceFiles = verifierOnly ? [] : sourceFiles;
  const userMessage: ChatMessage = {
    role: "user",
    content: prompt,
    files: activeSourceFiles,
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
      ? "You are the final Vera verifier. Use only the saved checkpoints and artifact manifest. Do not call tools or create documents. Return PASS or GAP for exactly four checks and never imply lawyer approval."
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
    },
    executionModel,
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
      const artifact = artifactFromCreatedEvent(event, stepIndex);
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
