import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { MikeAssistantStreamEvent } from "../assistantCompatibility";
import { WorkspaceIdSchema } from "../contracts";
import type { WorkspaceDatabaseAdapter } from "../migrations";
import type { TabularReviewDetail } from "../repositories/tabular";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
} from "./assistantRuntime";
import type { WorkspaceAssistantActionLedger } from "./assistantActionLedger";
import type { AssistantToolModule } from "./assistantToolRegistry";

export const ASSISTANT_CONTRACT_REVIEW_TOOL_MODULE_ID =
  "workspace-contract-review-tools";
export const ASSISTANT_CONTRACT_REVIEW_TOOL_ADAPTER_ID =
  "vera-local-contract-review-tools-v1";

const PRESETS = Object.freeze({
  commercial_agreement: Object.freeze({
    upstreamId: "builtin-commercial-agreement-tabular-review",
    title: "Commercial Agreement Review",
  }),
  change_of_control: Object.freeze({
    upstreamId: "builtin-coc-dd-tabular-review",
    title: "Change of Control Review",
  }),
});
type ContractReviewPreset = keyof typeof PRESETS;

const RunInput = z
  .object({ preset: z.enum(["commercial_agreement", "change_of_control"]) })
  .strict();
const GetInput = z.object({ review_id: WorkspaceIdSchema }).strict();

const RUN_TOOL: AssistantToolDefinition = Object.freeze({
  name: "run_contract_review",
  description:
    "Run one server-approved contract-review preset over all documents explicitly attached to this Matter message. The review is durable and idempotent. It may return running after a bounded wait; then use get_contract_review with the returned review_id.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      preset: Object.freeze({
        type: "string",
        enum: Object.freeze(["commercial_agreement", "change_of_control"]),
      }),
    }),
    required: Object.freeze(["preset"]),
    additionalProperties: false,
  }),
});

const GET_TOOL: AssistantToolDefinition = Object.freeze({
  name: "get_contract_review",
  description:
    "Resume the exact contract review created by this Assistant generation. It waits briefly, returns bounded progress, and creates the existing v23 Studio memo exactly once only after every review cell completes.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      review_id: Object.freeze({ type: "string", format: "uuid" }),
    }),
    required: Object.freeze(["review_id"]),
    additionalProperties: false,
  }),
});

const TOOLS = Object.freeze([RUN_TOOL, GET_TOOL]);
const MAX_TRACKED_GENERATIONS = 256;
const DEFAULT_MAX_WAIT_MS = 12_000;
const DEFAULT_INITIAL_POLL_MS = 50;
const DEFAULT_MAX_POLL_MS = 1_000;

export interface AssistantContractReviewTabularPort {
  get(id: string): TabularReviewDetail;
  createPresetReviewWithId(id: string, value: unknown): TabularReviewDetail;
  runReview(id: string): { review: TabularReviewDetail };
  cancelReview(id: string): TabularReviewDetail;
}

export interface AssistantContractReviewWorkflowPort {
  resolveMikeWorkflowId(id: string): string;
  getMikeBuiltinMapping(id: string): { upstreamId: string } | null;
}

export type ContractReviewStudioMemo = Readonly<{
  documentId: string;
  versionId: string;
  title: string;
}>;

type GenerationState = {
  context: AssistantToolContext;
  emittedReviewIds: Set<string>;
  emittedDraftIds: Set<string>;
  cancellation: null | Readonly<{
    reviewId: string;
    signal: AbortSignal;
    release: () => void;
  }>;
};

export class AssistantContractReviewToolError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(message = "Assistant contract review rejected the operation.") {
    super(message);
    this.name = "AssistantContractReviewToolError";
  }
}

function toolInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AssistantContractReviewToolError();
  return parsed.data;
}

function generationKey(context: AssistantToolContext) {
  return `${context.jobId}\0${context.attempt}`;
}

function abortError() {
  const error = new Error("Assistant contract review was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function deterministicUuid(material: string) {
  const bytes = Buffer.from(createHash("sha256").update(material).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function attachedSnapshots(context: AssistantToolContext) {
  const documents = context.documents
    .filter((document) => document.attached)
    .map((document) => ({
      documentId: document.documentId,
      versionId: document.versionId,
    }))
    .sort(
      (left, right) =>
        left.documentId.localeCompare(right.documentId) ||
        left.versionId.localeCompare(right.versionId),
    );
  if (documents.length < 2 || documents.length > 50) {
    throw new AssistantContractReviewToolError(
      "Attach between 2 and 50 current Matter documents for contract review.",
    );
  }
  if (new Set(documents.map((item) => item.documentId)).size !== documents.length) {
    throw new AssistantContractReviewToolError(
      "Attached contract review documents must be unique.",
    );
  }
  return documents;
}

function actionBinding(context: AssistantToolContext, preset: ContractReviewPreset) {
  if (!context.projectId) throw new AssistantContractReviewToolError();
  const documents = attachedSnapshots(context);
  const input = {
    schema: "vera-assistant-contract-review-action-v1",
    projectId: context.projectId,
    preset,
    upstreamWorkflowId: PRESETS[preset].upstreamId,
    modelProfileId: context.modelProfileId,
    documents,
  } as const;
  const reviewId = deterministicUuid(
    JSON.stringify([context.jobId, input]),
  );
  return {
    projectId: context.projectId,
    documents,
    documentIds: documents.map((item) => item.documentId),
    input,
    actionKey: `contract-review:${reviewId}`,
    reviewId,
  };
}

function reviewRoute(projectId: string, reviewId: string) {
  return `/projects/${projectId}/tabular-reviews/${reviewId}`;
}

function terminal(status: TabularReviewDetail["review"]["status"]) {
  return ["complete", "failed", "cancelled", "archived"].includes(status);
}

function safeError(error: TabularReviewDetail["cells"][number]["error"]) {
  return error
    ? { code: error.code, message: error.message.slice(0, 1_000), retryable: error.retryable }
    : null;
}

/**
 * High-level orchestration only: the model chooses one of two reviewed
 * presets, while the server owns document scope, ids, cell jobs, replay, and
 * the v23 evidence-to-Studio handoff.
 */
export class WorkspaceAssistantContractReviewToolModule
  implements AssistantToolModule
{
  readonly id = ASSISTANT_CONTRACT_REVIEW_TOOL_MODULE_ID;
  readonly adapterId = ASSISTANT_CONTRACT_REVIEW_TOOL_ADAPTER_ID;
  private readonly generations = new Map<string, GenerationState>();
  private readonly highestAttempts = new Map<string, number>();
  private readonly maxWaitMs: number;
  private readonly initialPollMs: number;
  private readonly maxPollMs: number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly tabular: () => AssistantContractReviewTabularPort,
    private readonly workflows: AssistantContractReviewWorkflowPort,
    private readonly actions: Pick<
      WorkspaceAssistantActionLedger,
      "reserve" | "complete" | "get"
    >,
    private readonly createStudioMemo: (
      projectId: string,
      reviewId: string,
    ) => Promise<ContractReviewStudioMemo>,
    private readonly available: () => boolean,
    options: Readonly<{
      maxWaitMs?: number;
      initialPollMs?: number;
      maxPollMs?: number;
      delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    }> = {},
  ) {
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.initialPollMs = options.initialPollMs ?? DEFAULT_INITIAL_POLL_MS;
    this.maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    if (
      !Number.isSafeInteger(this.maxWaitMs) ||
      this.maxWaitMs < 0 ||
      !Number.isSafeInteger(this.initialPollMs) ||
      this.initialPollMs < 1 ||
      !Number.isSafeInteger(this.maxPollMs) ||
      this.maxPollMs < this.initialPollMs
    ) {
      throw new Error("Assistant contract-review polling configuration is invalid.");
    }
    this.delay =
      options.delay ??
      ((milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(abortError());
          const timeout = setTimeout(done, milliseconds);
          function done() {
            signal.removeEventListener("abort", cancelled);
            resolve();
          }
          function cancelled() {
            clearTimeout(timeout);
            signal.removeEventListener("abort", cancelled);
            reject(abortError());
          }
          signal.addEventListener("abort", cancelled, { once: true });
        }));
  }

  async registeredTools(context: AssistantToolContext) {
    if (!context.projectId || !this.available()) return [];
    const highest = this.highestAttempts.get(context.jobId);
    if (highest !== undefined && context.attempt < highest) {
      throw new AssistantContractReviewToolError(
        "Contract review registration is older than the current job attempt.",
      );
    }
    this.highestAttempts.delete(context.jobId);
    this.highestAttempts.set(context.jobId, context.attempt);
    for (const [key, value] of this.generations) {
      if (value.context.jobId === context.jobId) {
        value.cancellation?.release();
        this.generations.delete(key);
      }
    }
    this.generations.set(generationKey(context), {
      context,
      emittedReviewIds: new Set(),
      emittedDraftIds: new Set(),
      cancellation: null,
    });
    while (this.generations.size > MAX_TRACKED_GENERATIONS) {
      const key = this.generations.keys().next().value as string | undefined;
      if (!key) break;
      this.generations.get(key)?.cancellation?.release();
      this.generations.delete(key);
    }
    while (this.highestAttempts.size > MAX_TRACKED_GENERATIONS) {
      const key = this.highestAttempts.keys().next().value as string | undefined;
      if (!key) break;
      this.highestAttempts.delete(key);
    }
    return TOOLS;
  }

  private generation(context: AssistantToolContext) {
    const state = this.generations.get(generationKey(context));
    if (
      !state ||
      state.context.chatId !== context.chatId ||
      state.context.projectId !== context.projectId ||
      state.context.modelProfileId !== context.modelProfileId ||
      !isDeepStrictEqual(state.context.documents, context.documents)
    ) {
      throw new AssistantContractReviewToolError(
        "Contract review tools are not registered for this job attempt.",
      );
    }
    return state;
  }

  private assertCurrentDocuments(
    projectId: string,
    documents: readonly { documentId: string; versionId: string }[],
  ) {
    for (const document of documents) {
      const row = this.database
        .prepare(
          `SELECT document.project_id,document.current_version_id,
                  document.deleted_at,version.deleted_at AS version_deleted_at
             FROM documents document
             JOIN document_versions version
               ON version.id=? AND version.document_id=document.id
            WHERE document.id=?`,
        )
        .get(document.versionId, document.documentId);
      if (
        !row ||
        row.project_id !== projectId ||
        row.current_version_id !== document.versionId ||
        row.deleted_at !== null ||
        row.version_deleted_at !== null
      ) {
        throw new AssistantContractReviewToolError(
          "An attached document is outside this Matter or no longer current.",
        );
      }
    }
  }

  private assertReviewBinding(
    detail: TabularReviewDetail,
    context: AssistantToolContext,
    preset: ContractReviewPreset,
  ) {
    const binding = actionBinding(context, preset);
    const upstreamId =
      detail.review.workflowId === null
        ? null
        : this.workflows.getMikeBuiltinMapping(detail.review.workflowId)?.upstreamId ?? null;
    if (
      detail.review.id !== binding.reviewId ||
      detail.review.projectId !== binding.projectId ||
      detail.review.modelProfileId !== context.modelProfileId ||
      detail.review.title !== PRESETS[preset].title ||
      upstreamId !== PRESETS[preset].upstreamId ||
      !isDeepStrictEqual(detail.review.documentIds, binding.documentIds)
    ) {
      throw new AssistantContractReviewToolError(
        "Persisted contract review does not match the immutable Assistant action.",
      );
    }
    this.assertCurrentDocuments(binding.projectId, binding.documents);
    const expectedVersions = new Map(
      binding.documents.map((document) => [document.documentId, document.versionId]),
    );
    for (const cell of detail.cells) {
      if (!cell.jobId) {
        if (cell.attempt !== 0) {
          throw new AssistantContractReviewToolError(
            "Contract review cell lineage is incomplete.",
          );
        }
        continue;
      }
      const job = this.database
        .prepare(
          `SELECT type,resource_type,resource_id,payload_json
             FROM jobs WHERE id=?`,
        )
        .get(cell.jobId);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(job?.payload_json)) as Record<string, unknown>;
      } catch {
        throw new AssistantContractReviewToolError(
          "Contract review cell job lineage is invalid.",
        );
      }
      const document = payload.document as Record<string, unknown> | undefined;
      const model = payload.model as Record<string, unknown> | undefined;
      if (
        job?.type !== "tabular_cell" ||
        job.resource_type !== "tabular_cell" ||
        job.resource_id !== cell.id ||
        payload.schema !== "vera-tabular-cell-job-v1" ||
        payload.reviewId !== detail.review.id ||
        payload.projectId !== binding.projectId ||
        payload.cellId !== cell.id ||
        document?.documentId !== cell.documentId ||
        document?.versionId !== expectedVersions.get(cell.documentId) ||
        model?.profileId !== context.modelProfileId
      ) {
        throw new AssistantContractReviewToolError(
          "Contract review cell job does not match the Assistant document-version snapshot.",
        );
      }
    }
    return binding;
  }

  private reviewEvent(
    state: GenerationState,
    detail: TabularReviewDetail,
  ): MikeAssistantStreamEvent[] {
    if (state.emittedReviewIds.has(detail.review.id)) return [];
    state.emittedReviewIds.add(detail.review.id);
    return [
      {
        type: "tabular_review_created",
        review_id: detail.review.id,
        title: detail.review.title,
        route: reviewRoute(detail.review.projectId!, detail.review.id),
        document_count: detail.review.documentIds.length,
      },
    ];
  }

  private async waitForTerminal(reviewId: string, signal: AbortSignal) {
    let detail = this.tabular().get(reviewId);
    const startedAt = Date.now();
    let pollMs = this.initialPollMs;
    while (!terminal(detail.review.status) && Date.now() - startedAt < this.maxWaitMs) {
      throwIfAborted(signal);
      const remaining = this.maxWaitMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await this.delay(Math.min(pollMs, remaining), signal);
      detail = this.tabular().get(reviewId);
      pollMs = Math.min(this.maxPollMs, pollMs * 2);
    }
    return detail;
  }

  private async result(
    detail: TabularReviewDetail,
    context: AssistantToolContext,
    preset: ContractReviewPreset,
    state: GenerationState,
    signal: AbortSignal,
  ) {
    this.assertReviewBinding(detail, context, preset);
    const events = this.reviewEvent(state, detail);
    const counts = { total: detail.cells.length, complete: 0, failed: 0, cancelled: 0 };
    for (const cell of detail.cells) {
      if (cell.status === "complete") counts.complete += 1;
      if (cell.status === "failed") counts.failed += 1;
      if (cell.status === "cancelled") counts.cancelled += 1;
    }
    let memo: ContractReviewStudioMemo | null = null;
    if (detail.review.status === "complete") {
      throwIfAborted(signal);
      memo = await this.createStudioMemo(context.projectId!, detail.review.id);
      throwIfAborted(signal);
      if (!state.emittedDraftIds.has(memo.documentId)) {
        state.emittedDraftIds.add(memo.documentId);
        events.push({
          type: "draft_created",
          draft_id: memo.documentId,
          version_id: memo.versionId,
          title: memo.title,
          route: `/projects/${context.projectId}/documents/${memo.documentId}/studio`,
        });
      }
    }
    const payload = {
      schema_version: "vera-assistant-contract-review-v1",
      review: {
        review_id: detail.review.id,
        title: detail.review.title,
        status: detail.review.status,
        terminal: terminal(detail.review.status),
        route: reviewRoute(context.projectId!, detail.review.id),
        document_count: detail.review.documentIds.length,
        progress: counts,
        error:
          detail.review.status === "failed"
            ? safeError(detail.cells.find((cell) => cell.status === "failed")?.error ?? null)
            : null,
      },
      memo:
        memo === null
          ? null
          : {
              draft_id: memo.documentId,
              version_id: memo.versionId,
              title: memo.title,
              route: `/projects/${context.projectId}/documents/${memo.documentId}/studio`,
            },
      asynchronous: !terminal(detail.review.status),
      instruction: terminal(detail.review.status)
        ? "Use the returned Review and Studio routes; binary XLSX/DOCX exports are intentionally not placed in model context."
        : "Call get_contract_review later with this review_id. Do not create another review.",
    };
    return { content: JSON.stringify(payload), events };
  }

  private retainCascadeCancellation(
    state: GenerationState,
    reviewId: string,
    signal: AbortSignal,
  ) {
    const existing = state.cancellation;
    if (existing?.reviewId === reviewId && existing.signal === signal) {
      throwIfAborted(signal);
      return;
    }
    existing?.release();
    const cancel = () => {
      try {
        const status = this.tabular().get(reviewId).review.status;
        if (!terminal(status)) this.tabular().cancelReview(reviewId);
      } catch {
        // Preserve the Assistant abort; review creation may not have committed.
      }
    };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", onAbort);
      if (state.cancellation?.release === release) state.cancellation = null;
    };
    const onAbort = () => {
      cancel();
      release();
    };
    state.cancellation = { reviewId, signal, release };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      throw abortError();
    }
  }

  private async withCascadeCancellation<T>(
    state: GenerationState,
    reviewId: string,
    signal: AbortSignal,
    operation: () => Promise<Readonly<{ value: T; terminal: boolean }>>,
  ) {
    this.retainCascadeCancellation(state, reviewId, signal);
    try {
      const result = await operation();
      if (result.terminal) state.cancellation?.release();
      return result.value;
    } catch (error) {
      state.cancellation?.release();
      throw error;
    }
  }

  private async run(
    context: AssistantToolContext,
    inputValue: unknown,
    signal: AbortSignal,
  ) {
    const input = toolInput(RunInput, inputValue);
    const state = this.generation(context);
    const binding = actionBinding(context, input.preset);
    this.assertCurrentDocuments(binding.projectId, binding.documents);
    const reservation = this.actions.reserve({
      jobId: context.jobId,
      attempt: context.attempt,
      leaseOwner: context.leaseOwner,
      projectId: binding.projectId,
      actionKey: binding.actionKey,
      actionType: "run_contract_review",
      input: binding.input,
    });
    if (
      reservation.record.status === "complete" &&
      (reservation.record.resourceType !== "tabular_review" ||
        reservation.record.resourceId !== binding.reviewId)
    ) {
      throw new AssistantContractReviewToolError(
        "Completed contract review action has an invalid durable resource.",
      );
    }
    let detail: TabularReviewDetail;
    try {
      detail = this.tabular().get(binding.reviewId);
      this.assertReviewBinding(detail, context, input.preset);
    } catch (error) {
      if (reservation.record.status === "complete") throw error;
      try {
        detail = this.tabular().createPresetReviewWithId(binding.reviewId, {
          projectId: binding.projectId,
          workflowId: PRESETS[input.preset].upstreamId,
          title: PRESETS[input.preset].title,
          documentIds: binding.documentIds,
          modelProfileId: context.modelProfileId,
          columns: [],
        });
      } catch (createError) {
        // A concurrent/recovered attempt may have committed the deterministic
        // id. Re-read and validate exact ownership instead of accepting a
        // uniqueness error or creating another review.
        try {
          detail = this.tabular().get(binding.reviewId);
          this.assertReviewBinding(detail, context, input.preset);
        } catch {
          throw createError;
        }
      }
    }
    this.actions.complete({
      jobId: context.jobId,
      attempt: context.attempt,
      leaseOwner: context.leaseOwner,
      projectId: binding.projectId,
      actionKey: binding.actionKey,
      actionType: "run_contract_review",
      input: binding.input,
      resourceType: "tabular_review",
      resourceId: binding.reviewId,
    });
    return this.withCascadeCancellation(state, binding.reviewId, signal, async () => {
      if (!terminal(detail.review.status)) {
        detail = this.tabular().runReview(binding.reviewId).review;
        detail = await this.waitForTerminal(binding.reviewId, signal);
      }
      return {
        value: await this.result(detail, context, input.preset, state, signal),
        terminal: terminal(detail.review.status),
      };
    });
  }

  private async getReview(
    context: AssistantToolContext,
    inputValue: unknown,
    signal: AbortSignal,
  ) {
    const input = toolInput(GetInput, inputValue);
    const state = this.generation(context);
    let preset: ContractReviewPreset | null = null;
    let binding: ReturnType<typeof actionBinding> | null = null;
    for (const candidate of Object.keys(PRESETS) as ContractReviewPreset[]) {
      const value = actionBinding(context, candidate);
      if (value.reviewId === input.review_id) {
        preset = candidate;
        binding = value;
        break;
      }
    }
    if (!preset || !binding) {
      throw new AssistantContractReviewToolError(
        "Contract review id is not owned by this Assistant generation.",
      );
    }
    const action = this.actions.get(context.jobId, binding.actionKey);
    if (
      !action ||
      action.status !== "complete" ||
      action.actionType !== "run_contract_review" ||
      action.projectId !== context.projectId ||
      action.resourceType !== "tabular_review" ||
      action.resourceId !== input.review_id
    ) {
      throw new AssistantContractReviewToolError(
        "Contract review id is not a completed Assistant action.",
      );
    }
    this.assertCurrentDocuments(binding.projectId, binding.documents);
    return this.withCascadeCancellation(state, input.review_id, signal, async () => {
      const detail = await this.waitForTerminal(input.review_id, signal);
      return {
        value: await this.result(detail, context, preset!, state, signal),
        terminal: terminal(detail.review.status),
      };
    });
  }

  execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    if (input.call.name === "run_contract_review") {
      return this.run(input.context, input.call.input, input.signal);
    }
    if (input.call.name === "get_contract_review") {
      return this.getReview(input.context, input.call.input, input.signal);
    }
    throw new AssistantContractReviewToolError();
  }
}
