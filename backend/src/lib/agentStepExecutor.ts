import {
  buildDocContext,
  buildMessages,
  buildWorkflowStore,
  runLLMStream,
  stripTransientAssistantEvents,
  type ChatMessage,
} from "./chat";
import {
  addAgentArtifactLinks,
  type AgentArtifactLinkInput,
} from "./agentTasks";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";

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
    completed.length ? `COMPLETED STEP CHECKPOINTS\n${completed.join("\n")}` : "",
    artifactManifest.length ? `LINKED ARTIFACTS\n${artifactManifest.join("\n")}` : "LINKED ARTIFACTS\nNone yet.",
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
  if (error || !data) throw new Error(error?.message ?? "Failed to create task chat");
  await addAgentArtifactLinks(db, snapshot.task.id, [
    { artifact_type: "chat", artifact_id: data.id, purpose: "Task execution record" },
  ]);
  return data.id as string;
}

export type AgentStepExecutionResult = {
  summary: string;
  artifacts: AgentArtifactLinkInput[];
  waitingForInput: boolean;
};

export async function executeAgentStep(input: {
  db: Db;
  snapshot: NonNullable<TaskSnapshot>;
  userId: string;
  userEmail?: string;
}): Promise<AgentStepExecutionResult> {
  const { db, snapshot, userId, userEmail } = input;
  const stepIndex = snapshot.task.current_plan.findIndex(
    (step: { status: string }) => step.status === "running",
  );
  if (stepIndex < 0) throw new Error("Running task has no executable step");

  const sourceIds = snapshot.artifacts
    .filter((artifact) => artifact.artifact_type === "document" && artifact.purpose === "Source document")
    .map((artifact) => artifact.artifact_id);
  if (sourceIds.length === 0 && stepIndex < 4) {
    return {
      summary: "Source documents are required before this step can run.",
      artifacts: [],
      waitingForInput: true,
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
  const prompt = taskPrompt(
    snapshot,
    stepIndex,
    snapshot.artifacts.map(
      (artifact) => `- ${artifact.purpose}: ${artifact.artifact_type}/${artifact.artifact_id}`,
    ),
  );
  const userMessage: ChatMessage = { role: "user", content: prompt, files: sourceFiles };
  const { error: userMessageError } = await db.from("chat_messages").insert({
    chat_id: chatId,
    role: "user",
    content: prompt,
    files: sourceFiles.length ? sourceFiles : null,
  });
  if (userMessageError) throw new Error(userMessageError.message);

  const { docIndex, docStore } = await buildDocContext([userMessage], userId, db, chatId);
  const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
    doc_id,
    filename: info.filename,
  }));
  const apiMessages = buildMessages(
    [userMessage],
    docAvailability,
    "You are executing one bounded step in a Vera legal Work Task. Preserve source boundaries, never imply lawyer approval, and use the existing Mike tools when the step requires a document artifact.",
    docIndex,
    false,
  );
  const [{ api_keys: apiKeys }, workflowStore] = await Promise.all([
    getUserModelSettings(userId, db),
    buildWorkflowStore(userId, userEmail, db),
  ]);
  const { fullText, events, citations } = await runLLMStream({
    apiMessages,
    docStore,
    docIndex,
    userId,
    db,
    write: () => {},
    workflowStore,
    includeResearchTools: false,
    model: "gemini-3-flash-preview",
    apiKeys,
    projectId: snapshot.task.matter_id,
  });
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
    throw new Error(assistantError?.message ?? "Failed to save task step result");
  }

  const artifactPurpose = stepIndex === 2 ? "Risk matrix" : stepIndex === 3 ? "Review memo draft" : "Generated document";
  const artifacts: AgentArtifactLinkInput[] = persistedEvents.flatMap((event) =>
    event.type === "doc_created" && event.document_id
      ? [
          {
            artifact_type: stepIndex === 3 ? ("draft" as const) : ("document" as const),
            artifact_id: event.document_id,
            purpose: artifactPurpose,
          },
        ]
      : [],
  );
  if (citations.length) {
    artifacts.push({
      artifact_type: "citation_snapshot",
      artifact_id: assistantMessage.id as string,
      purpose: `Step ${stepIndex + 1} evidence citations`,
    });
  }
  const waitingForInput = persistedEvents.some((event) => event.type === "ask_inputs");
  const contentText = persistedEvents
    .filter((event): event is Extract<typeof event, { type: "content" }> => event.type === "content")
    .map((event) => event.text)
    .join("\n")
    .trim();
  return {
    summary: (contentText || fullText || `Step ${stepIndex + 1} completed.`).slice(0, 4000),
    artifacts,
    waitingForInput,
  };
}
