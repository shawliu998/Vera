import { z } from "zod";

import { SafeStructuredValueSchema, WorkspaceIdSchema } from "../contracts";
import { WorkspaceApiError } from "../errors";
import type { AssistantRetrievalChunk } from "../repositories/assistantRetrieval";
import type {
  WorkflowDocumentContextResult,
  WorkflowDocumentSnapshot,
} from "../repositories/workflowDocumentContext";
import { WORKFLOW_DOCUMENT_CONTEXT_LIMITS } from "../repositories/workflowDocumentContext";
import type { WorkflowExecutionSnapshot } from "../repositories/workflows";
import type { WorkflowRunStep } from "../repositories/workflows";
import type { WorkflowStep, WorkspaceJson } from "../types";
import {
  AssistantModelSourcesSchema,
  type AssistantModelPort,
} from "./assistantRuntime";
import type {
  WorkflowPreparedStepInput,
  WorkflowStepExecutionResult,
  WorkflowStepExecutor,
} from "./workflowRuntime";

const MAX_INPUT_BINDING_JSON_CHARS = 20_000;
const MAX_PRIOR_OUTPUT_CHARS = 40_000;
const MAX_MODEL_USER_PROMPT_CHARS = 180_000;
const MAX_MODEL_SYSTEM_PROMPT_CHARS = 120_000;
const MAX_PERSISTED_STEP_INPUT_JSON_CHARS = 400_000;
const MAX_MODEL_OUTPUT_CHARS = 200_000;

const DocumentContextInputSchema = z
  .object({
    schema: z.literal("vera-workflow-document-context-v1"),
    kind: z.literal("document_context"),
    projectId: WorkspaceIdSchema,
    query: z.string().trim().min(1).max(2_000),
    documentIds: z.array(WorkspaceIdSchema).max(20),
    maxDocuments: z.number().int().min(1).max(20),
    maxChunksPerDocument: z.number().int().min(1).max(20),
    resultLimit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const DocumentSnapshotSchema = z
  .object({
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    filename: z.string().min(1).max(240),
  })
  .strict();

const EvidenceSchema = z
  .object({
    chunkId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    filename: z.string().min(1).max(240),
    ordinal: z.number().int().nonnegative(),
    text: z.string().min(1).max(100_000),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    pageStart: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    score: z.number().finite(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.endOffset - value.startOffset !== value.text.length ||
      (value.pageStart !== null &&
        value.pageEnd !== null &&
        value.pageEnd < value.pageStart)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Workflow evidence offsets are invalid.",
      });
    }
  });

const DocumentContextOutputSchema = z
  .object({
    schema: z.literal("vera-workflow-document-context-result-v1"),
    kind: z.literal("document_context"),
    query: z.string().max(2_000),
    documents: z.array(DocumentSnapshotSchema).max(20),
    evidence: z.array(EvidenceSchema).max(100),
  })
  .strict();

const ModelDocumentSchema = z
  .object({
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    attached: z.literal(false),
  })
  .strict();

const PromptInputSchema = z
  .object({
    schema: z.literal("vera-workflow-prompt-input-v1"),
    kind: z.literal("prompt"),
    systemPrompt: z.string().min(1).max(MAX_MODEL_SYSTEM_PROMPT_CHARS),
    userPrompt: z.string().min(1).max(MAX_MODEL_USER_PROMPT_CHARS),
    documents: z.array(ModelDocumentSchema).max(20),
    evidence: z.array(EvidenceSchema).max(100),
  })
  .strict();

const PromptOutputSchema = z
  .object({
    schema: z.literal("vera-workflow-prompt-result-v1"),
    kind: z.literal("prompt"),
    content: z.string().max(MAX_MODEL_OUTPUT_CHARS),
    sources: AssistantModelSourcesSchema,
    model: z
      .object({
        adapter: z.literal("workspace_assistant_model"),
        streaming: z.literal(true),
        toolCalling: z.literal(true),
      })
      .strict(),
  })
  .strict();

const OutputInputSchema = z
  .object({
    schema: z.literal("vera-workflow-output-input-v1"),
    kind: z.literal("output"),
    format: z.enum(["text", "json"]),
    content: z.string().max(MAX_MODEL_OUTPUT_CHARS),
    sources: AssistantModelSourcesSchema,
  })
  .strict();

const OutputTextResultSchema = z
  .object({
    schema: z.literal("vera-workflow-output-result-v1"),
    kind: z.literal("output"),
    format: z.literal("text"),
    content: z.string().max(MAX_MODEL_OUTPUT_CHARS),
    sources: AssistantModelSourcesSchema,
  })
  .strict();

const OutputJsonResultSchema = z
  .object({
    schema: z.literal("vera-workflow-output-result-v1"),
    kind: z.literal("output"),
    format: z.literal("json"),
    value: SafeStructuredValueSchema,
    sources: AssistantModelSourcesSchema,
  })
  .strict();

export interface WorkflowDocumentContextPort {
  retrieve(input: {
    projectId: string;
    query: string;
    documentIds: readonly string[];
    maxDocuments: number;
    maxChunksPerDocument: number;
    signal: AbortSignal;
  }): WorkflowDocumentContextResult;
}

export type WorkflowStepExecutorOptions = Readonly<{
  assertModelUse?: (input: {
    projectId: string;
    documentId: string;
    versionId: string;
  }) => void;
}>;

function jsonText(value: WorkspaceJson, limit: number, label: string) {
  const text = JSON.stringify(value);
  if (text.length > limit) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      `${label} exceeds the workflow execution context budget.`,
    );
  }
  return text;
}

function stringsFrom(
  value: WorkspaceJson,
  remaining: { value: number },
): string[] {
  if (remaining.value <= 0) return [];
  if (typeof value === "string") {
    const text = value.trim().slice(0, remaining.value);
    remaining.value -= text.length;
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFrom(item, remaining));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...stringsFrom(item, remaining),
    ]);
  }
  return [];
}

function selectedDocumentIds(inputBinding: WorkspaceJson): string[] {
  if (
    inputBinding === null ||
    typeof inputBinding !== "object" ||
    Array.isArray(inputBinding) ||
    !("document_ids" in inputBinding)
  ) {
    return [];
  }
  return z
    .array(WorkspaceIdSchema)
    .max(WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxDocuments)
    .parse(inputBinding.document_ids);
}

function promptContent(output: WorkspaceJson | null): string | null {
  const result = PromptOutputSchema.safeParse(output);
  return result.success ? result.data.content : null;
}

function documentContext(
  output: WorkspaceJson | null,
): z.infer<typeof DocumentContextOutputSchema> | null {
  const result = DocumentContextOutputSchema.safeParse(output);
  return result.success ? result.data : null;
}

function latestHistory(steps: readonly WorkflowRunStep[]) {
  const latest = new Map<number, WorkflowRunStep>();
  for (const step of steps) {
    const existing = latest.get(step.ordinal);
    if (!existing || step.attempt >= existing.attempt) {
      latest.set(step.ordinal, step);
    }
  }
  return [...latest.values()].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
}

function boundedPriorAnswers(steps: readonly WorkflowRunStep[]) {
  let remaining = MAX_PRIOR_OUTPUT_CHARS;
  const values: string[] = [];
  for (const step of latestHistory(steps)) {
    const content = promptContent(step.output);
    if (content === null || remaining <= 0) continue;
    const bounded = content.slice(0, remaining);
    remaining -= bounded.length;
    values.push(
      `Completed step ${step.ordinal + 1} (${step.step.title}):\n${bounded}`,
    );
  }
  return values;
}

function boundedEvidence(steps: readonly WorkflowRunStep[]) {
  const documents = new Map<string, WorkflowDocumentSnapshot>();
  const evidence = new Map<string, AssistantRetrievalChunk>();
  let remainingChars = WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxTextChars;
  for (const step of latestHistory(steps)) {
    const context = documentContext(step.output);
    if (!context) continue;
    for (const document of context.documents) {
      const key = `${document.documentId}\0${document.versionId}`;
      if (
        documents.size < WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxDocuments &&
        !documents.has(key)
      ) {
        documents.set(key, document);
      }
    }
    for (const chunk of context.evidence) {
      const documentKey = `${chunk.documentId}\0${chunk.versionId}`;
      if (
        !documents.has(documentKey) ||
        evidence.has(chunk.chunkId) ||
        evidence.size >= WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunks ||
        remainingChars <= 0
      ) {
        continue;
      }
      const text = chunk.text.slice(0, remainingChars);
      if (!text) continue;
      evidence.set(chunk.chunkId, {
        ...chunk,
        text,
        endOffset: chunk.startOffset + text.length,
      });
      remainingChars -= text.length;
    }
  }
  return {
    documents: [...documents.values()],
    evidence: [...evidence.values()],
  };
}

function buildSystemPrompt(snapshot: WorkflowExecutionSnapshot) {
  const skill = snapshot.skillMarkdown.trim();
  const prompt = [
    "You are Vera's local legal workflow executor.",
    "Execute only the immutable workflow step and local evidence supplied in this request.",
    "Do not use network, shell, Python, external tools, hidden files, or facts not supported by the request.",
    "If evidence is insufficient, say so plainly. Do not invent legal authorities, clauses, parties, dates, or citations.",
    "When relying on supplied evidence, use consecutive [n] markers and append a hidden <CITATIONS> JSON array with exact quotes, then </CITATIONS>.",
    skill ? `Immutable workflow instructions:\n${skill}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (prompt.length > MAX_MODEL_SYSTEM_PROMPT_CHARS) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Workflow skill exceeds the model context budget.",
    );
  }
  return prompt;
}

function buildEvidenceText(
  documents: readonly WorkflowDocumentSnapshot[],
  evidence: readonly AssistantRetrievalChunk[],
) {
  const labels = new Map(
    documents.map((document, index) => [
      `${document.documentId}\0${document.versionId}`,
      `doc-${index}`,
    ]),
  );
  return evidence
    .map((chunk) => {
      const label = labels.get(`${chunk.documentId}\0${chunk.versionId}`);
      if (!label) return "";
      const page =
        chunk.pageStart === null
          ? ""
          : ` pages ${chunk.pageStart}-${chunk.pageEnd ?? chunk.pageStart}`;
      return `[${label} chunk ${chunk.ordinal}${page} offsets ${chunk.startOffset}-${chunk.endOffset}]\n${chunk.text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function ensurePersistedInputBudget(value: WorkspaceJson) {
  const parsed = SafeStructuredValueSchema.parse(value);
  if (JSON.stringify(parsed).length > MAX_PERSISTED_STEP_INPUT_JSON_CHARS) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Workflow step input exceeds the durable execution budget.",
    );
  }
  return parsed;
}

function asWorkspaceJson(value: unknown): WorkspaceJson {
  return SafeStructuredValueSchema.parse(value) as WorkspaceJson;
}

function redactEvidenceForDurableHistory(
  evidence: readonly AssistantRetrievalChunk[],
) {
  return evidence
    .map((chunk) => {
      const text = chunk.text
        .replace(
          /(?:bearer\s+)[a-z0-9._~+\/-]+|\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi,
          "[redacted]",
        )
        .replace(
          /(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g,
          "[redacted-path]",
        );
      return text.trim()
        ? { ...chunk, text, endOffset: chunk.startOffset + text.length }
        : null;
    })
    .filter((chunk): chunk is AssistantRetrievalChunk => chunk !== null);
}

/**
 * Production Workflow executor. Prompt steps share the audited Assistant model
 * adapter; document_context steps use only current-version local FTS evidence.
 */
export class WorkspaceWorkflowStepExecutor implements WorkflowStepExecutor {
  constructor(
    private readonly model: AssistantModelPort,
    private readonly documents: WorkflowDocumentContextPort,
    private readonly options: WorkflowStepExecutorOptions = {},
  ) {}

  private assertPromptModelUse(
    projectId: string | null,
    documents: readonly z.infer<typeof ModelDocumentSchema>[],
  ) {
    if (documents.length === 0) return;
    if (!projectId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Workflow evidence requires a project-scoped run.",
      );
    }
    for (const document of documents) {
      this.options.assertModelUse?.({
        projectId,
        documentId: document.documentId,
        versionId: document.versionId,
      });
    }
  }

  prepareStep(input: {
    snapshot: WorkflowExecutionSnapshot;
    step: WorkflowStep;
    ordinal: number;
    history: readonly WorkflowRunStep[];
  }): WorkflowPreparedStepInput {
    if (input.step.kind === "tabular_column") {
      return {
        status: "unsupported",
        message:
          "Tabular workflow steps are owned by the Tabular runtime and cannot execute in the Assistant workflow runner.",
      };
    }
    if (input.step.kind === "document_context") {
      if (!input.snapshot.projectId) {
        throw new WorkspaceApiError(
          412,
          "PRECONDITION_FAILED",
          "document_context requires a project-scoped workflow run.",
        );
      }
      const nextPrompt = input.snapshot.steps
        .slice(input.ordinal + 1)
        .find((step) => step.kind === "prompt");
      const query = (
        input.step.queryTemplate ??
        [
          input.step.title,
          nextPrompt?.kind === "prompt" ? nextPrompt.prompt : "",
          input.snapshot.skillMarkdown,
          ...stringsFrom(input.snapshot.inputBinding, {
            value: WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxQueryChars,
          }),
        ]
          .filter(Boolean)
          .join(" ")
      )
        .slice(0, WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxQueryChars)
        .trim();
      if (!query) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "document_context has no bounded keyword query source.",
        );
      }
      return {
        status: "ready",
        input: ensurePersistedInputBudget(
          asWorkspaceJson({
            schema: "vera-workflow-document-context-v1",
            kind: "document_context",
            projectId: input.snapshot.projectId,
            query,
            documentIds: selectedDocumentIds(input.snapshot.inputBinding),
            maxDocuments: Math.min(
              input.step.maxDocuments,
              WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxDocuments,
            ),
            maxChunksPerDocument: Math.min(
              input.step.maxChunksPerDocument,
              WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunksPerDocument,
            ),
            ...(input.step.resultLimit === undefined
              ? {}
              : { resultLimit: input.step.resultLimit }),
          }),
        ),
      };
    }

    if (input.step.kind === "output") {
      const priorPrompt = [...latestHistory(input.history)]
        .reverse()
        .find(
          (step) =>
            step.step.kind === "prompt" && promptContent(step.output) !== null,
        );
      const prompt = priorPrompt
        ? PromptOutputSchema.safeParse(priorPrompt.output)
        : null;
      if (!prompt?.success) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "The output step requires a completed prompt result.",
        );
      }
      return {
        status: "ready",
        input: ensurePersistedInputBudget(
          asWorkspaceJson(
            OutputInputSchema.parse({
              schema: "vera-workflow-output-input-v1",
              kind: "output",
              format: input.step.format,
              content: prompt.data.content,
              sources: prompt.data.sources,
            }),
          ),
        ),
      };
    }

    if (
      input.step.modelProfileId !== undefined &&
      input.step.modelProfileId !== input.snapshot.modelProfileId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A prompt step model profile must match the immutable run model profile.",
      );
    }

    const inputBinding = jsonText(
      input.snapshot.inputBinding,
      MAX_INPUT_BINDING_JSON_CHARS,
      "Workflow input binding",
    );
    const context = boundedEvidence(input.history);
    const sections = [
      `Current step ${input.ordinal + 1}: ${input.step.title}`,
      `Step instructions:\n${input.step.prompt}`,
      `Immutable run input binding:\n${inputBinding}`,
      ...boundedPriorAnswers(input.history),
    ];
    const evidenceText = buildEvidenceText(context.documents, context.evidence);
    if (evidenceText)
      sections.push(`Local current-version evidence:\n${evidenceText}`);
    const userPrompt = sections.join("\n\n");
    if (userPrompt.length > MAX_MODEL_USER_PROMPT_CHARS) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow prompt exceeds the model context budget.",
      );
    }
    return {
      status: "ready",
      input: ensurePersistedInputBudget(
        asWorkspaceJson({
          schema: "vera-workflow-prompt-input-v1",
          kind: "prompt",
          systemPrompt: buildSystemPrompt(input.snapshot),
          userPrompt,
          documents: context.documents.map((document) => ({
            documentId: document.documentId,
            versionId: document.versionId,
            attached: false,
          })),
          evidence: context.evidence,
        }),
      ),
    };
  }

  async executeStep(input: {
    snapshot: WorkflowExecutionSnapshot;
    step: WorkflowStep;
    ordinal: number;
    stepInput: WorkspaceJson;
    history: readonly WorkflowRunStep[];
    signal: AbortSignal;
  }): Promise<WorkflowStepExecutionResult> {
    if (input.signal.aborted) throw this.abortError();
    if (input.step.kind === "tabular_column") {
      return {
        status: "unsupported",
        message:
          "Tabular workflow steps cannot execute in the Assistant workflow runner.",
      };
    }
    if (input.step.kind === "document_context") {
      const prepared = DocumentContextInputSchema.parse(input.stepInput);
      const result = this.documents.retrieve({
        projectId: prepared.projectId,
        query: prepared.query,
        documentIds: prepared.documentIds,
        maxDocuments: prepared.maxDocuments,
        maxChunksPerDocument: prepared.maxChunksPerDocument,
        signal: input.signal,
      });
      if (input.signal.aborted) throw this.abortError();
      const evidence = redactEvidenceForDurableHistory(result.evidence).slice(
        0,
        prepared.resultLimit ?? WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunks,
      );
      return {
        status: "complete",
        output: asWorkspaceJson(
          DocumentContextOutputSchema.parse({
            schema: "vera-workflow-document-context-result-v1",
            kind: "document_context",
            query: prepared.query,
            documents: result.documents,
            evidence,
          }),
        ),
      };
    }

    if (input.step.kind === "output") {
      const prepared = OutputInputSchema.parse(input.stepInput);
      if (prepared.format !== input.step.format) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Output step input does not match its immutable format.",
        );
      }
      if (prepared.format === "text") {
        return {
          status: "complete",
          output: asWorkspaceJson(
            OutputTextResultSchema.parse({
              schema: "vera-workflow-output-result-v1",
              kind: "output",
              format: "text",
              content: prepared.content,
              sources: prepared.sources,
            }),
          ),
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(prepared.content);
      } catch {
        throw new WorkspaceApiError(
          422,
          "VALIDATION_ERROR",
          "The output step expected the final prompt to contain valid JSON.",
        );
      }
      const value = SafeStructuredValueSchema.safeParse(parsed);
      if (!value.success) {
        throw new WorkspaceApiError(
          422,
          "VALIDATION_ERROR",
          "The output step JSON is outside the safe structured-value contract.",
        );
      }
      return {
        status: "complete",
        output: asWorkspaceJson(
          OutputJsonResultSchema.parse({
            schema: "vera-workflow-output-result-v1",
            kind: "output",
            format: "json",
            value: value.data,
            sources: prepared.sources,
          }),
        ),
      };
    }

    if (
      input.step.modelProfileId !== undefined &&
      input.step.modelProfileId !== input.snapshot.modelProfileId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A prompt step model profile must match the immutable run model profile.",
      );
    }

    const prepared = PromptInputSchema.parse(input.stepInput);
    const capability = await this.model.registeredCapabilities({
      modelProfileId: input.snapshot.modelProfileId ?? "",
    });
    if (!capability.streaming || !capability.toolCalling) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Workflow model adapter lacks required streaming capability.",
      );
    }
    // Evidence is durable across workflow steps, while legal-source retention
    // can expire or be tombstoned between those steps. Re-evaluate every
    // document immediately before the model boundary instead of trusting the
    // earlier document_context retrieval decision.
    this.assertPromptModelUse(input.snapshot.projectId, prepared.documents);
    let streamed = "";
    const turn = await this.model.runTurn({
      modelProfileId: input.snapshot.modelProfileId ?? "",
      projectId: input.snapshot.projectId,
      operation: "workflow_prompt",
      systemPrompt: prepared.systemPrompt,
      messages: [{ role: "user", content: prepared.userPrompt }],
      tools: [],
      documents: prepared.documents,
      evidence: prepared.evidence,
      signal: input.signal,
      onTextDelta: async (delta) => {
        streamed += delta;
        if (streamed.length > MAX_MODEL_OUTPUT_CHARS) {
          throw new WorkspaceApiError(
            502,
            "JOB_FAILED",
            "Workflow model output exceeds the durable output budget.",
          );
        }
      },
      onReasoningDelta: async () => {},
      onReasoningBlockEnd: async () => {},
    });
    if (input.signal.aborted) throw this.abortError();
    if (turn.toolCalls.length > 0 || turn.content !== streamed) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Workflow model output did not match the registered streaming contract.",
      );
    }
    return {
      status: "complete",
      output: asWorkspaceJson(
        PromptOutputSchema.parse({
          schema: "vera-workflow-prompt-result-v1",
          kind: "prompt",
          content: turn.content,
          sources: turn.sources,
          model: {
            adapter: "workspace_assistant_model",
            streaming: true,
            toolCalling: true,
          },
        }),
      ),
    };
  }

  private abortError() {
    const error = new Error("Workflow execution aborted.");
    error.name = "AbortError";
    return error;
  }
}
