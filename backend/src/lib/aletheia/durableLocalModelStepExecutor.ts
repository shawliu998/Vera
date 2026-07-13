import { createHash } from "node:crypto";
import type {
  DurableStepExecution,
  DurableStepExecutor,
} from "./durableAgentExecutor";
import {
  LocalModelScheduler,
  type LocalModelMessage,
} from "./localModelScheduler";
import {
  CONTEXT_COMPRESSION_HYGIENE_THRESHOLD,
  CONTEXT_COMPRESSION_PRIMARY_THRESHOLD,
  ContextCompressionError,
  buildContextDigestPrompt,
  estimateContextTokens,
  parseContextDigest,
  prepareCompressibleContext,
  renderContextDigest,
  type CompressibleContextMessage,
  type ContextCompressionPolicy,
  type ContextDigestSource,
} from "./contextCompression";
import {
  LITIGATION_GROUNDED_HANDLER,
  parseGroundedLitigationOutput,
  renderGroundedLitigationOutput,
} from "./litigationGrounding";

export const LOCAL_MODEL_GENERATE_HANDLER = "local_model.generate";
const FAST_MODE_MAX_OUTPUT_TOKENS = 1_024;

export type DurableModelPolicyContext = Pick<
  DurableStepExecution,
  | "runId"
  | "matterId"
  | "userId"
  | "workflow"
  | "modelProfile"
  | "stepKey"
  | "handler"
> & { input: Record<string, unknown> };

export type DurableModelIdResolver = (context: DurableModelPolicyContext) =>
  | string
  | {
      modelId: string;
      contextBudgetTokens?: number;
      maxOutputTokens?: number;
      reasoning?: "Off" | "Low" | "Medium" | "High";
      fastMode?: boolean;
      matterMemoryContext?: string;
      contextCompression?: ContextCompressionPolicy;
    }
  | Promise<
      | string
      | {
          modelId: string;
          contextBudgetTokens?: number;
          maxOutputTokens?: number;
          reasoning?: "Off" | "Low" | "Medium" | "High";
          fastMode?: boolean;
          matterMemoryContext?: string;
          contextCompression?: ContextCompressionPolicy;
        }
    >;

const estimatedTokens = estimateContextTokens;

function optionalString(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function trimToTokenBudget(value: string | undefined, tokenBudget: number) {
  if (!value || tokenBudget <= 0) return "";
  const maxBytes = Math.max(0, tokenBudget * 3);
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result.trim();
}

function systemContext(base: string | undefined, memory: string) {
  if (!memory) return base;
  return [base, memory].filter(Boolean).join("\n\n");
}

function contextMessages(
  value: unknown,
): CompressibleContextMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: CompressibleContextMessage[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = optionalString(record.content, 1_000_000);
    if (
      (role === "system" || role === "user" || role === "assistant") &&
      content
    ) {
      result.push({
        role,
        content,
        id: optionalString(record.id, 256),
        evidenceIds: Array.isArray(record.evidenceIds)
          ? record.evidenceIds
              .filter((item): item is string => typeof item === "string")
              .slice(0, 100)
          : undefined,
        originRun: optionalString(record.originRun, 256),
        toolPairId: optionalString(record.toolPairId, 256),
        expiresAt: optionalString(record.expiresAt, 128),
      });
    }
  }
  return result.length ? result : undefined;
}

function protectedMessageIndexes(length: number) {
  const head = Math.min(2, length);
  const tailStart = Math.max(head, length - 4);
  return { head, tailStart };
}

function compressionSources(
  messages: CompressibleContextMessage[],
  originRun: string,
): ContextDigestSource[] {
  return messages.map((message, index) => ({
    messageId: message.id ?? `message-${index + 1}`,
    sourceHash: `sha256:${createHash("sha256")
      .update(JSON.stringify({ role: message.role, content: message.content }))
      .digest("hex")}`,
    evidenceIds: message.evidenceIds ?? [],
    originRun: message.originRun ?? originRun,
  }));
}

/**
 * Narrow bridge from the durable queue to the local-only model scheduler.
 * The model id is resolved by server policy and is deliberately not read from
 * the client-controlled step input.
 */
export class DurableLocalModelStepExecutor implements DurableStepExecutor {
  constructor(
    private readonly scheduler: LocalModelScheduler,
    private readonly resolveModelId: DurableModelIdResolver,
  ) {}

  async execute(step: DurableStepExecution) {
    if (
      step.handler !== LOCAL_MODEL_GENERATE_HANDLER &&
      step.handler !== LITIGATION_GROUNDED_HANDLER
    ) {
      throw new Error(`Unregistered durable step handler: ${step.handler}`);
    }
    const prompt = optionalString(step.input.prompt, 1_000_000);
    const inputMessages = contextMessages(step.input.messages);
    if (!prompt && !inputMessages) {
      throw new Error("local_model.generate requires prompt or messages");
    }
    const resolvedPolicy = await this.resolveModelId({
      matterId: step.matterId,
      userId: step.userId,
      workflow: step.workflow,
      runId: step.runId,
      modelProfile: step.modelProfile,
      stepKey: step.stepKey,
      handler: step.handler,
      input: step.input,
    });
    const policy =
      typeof resolvedPolicy === "string"
        ? { modelId: resolvedPolicy }
        : resolvedPolicy;
    if (!policy.modelId)
      throw new Error("Server model policy did not resolve a local model");
    const requestedOutputTokens = optionalNumber(step.input.maxOutputTokens);
    const policyOutputTokens = policy.fastMode
      ? Math.min(
          policy.maxOutputTokens ?? FAST_MODE_MAX_OUTPUT_TOKENS,
          FAST_MODE_MAX_OUTPUT_TOKENS,
        )
      : policy.maxOutputTokens;
    const maxOutputTokens = policy.maxOutputTokens
      ? Math.min(
          requestedOutputTokens ?? policyOutputTokens ?? policy.maxOutputTokens,
          policyOutputTokens ?? policy.maxOutputTokens,
        )
      : (requestedOutputTokens ?? policyOutputTokens);
    const baseSystemPrompt = optionalString(step.input.systemPrompt, 200_000);
    const availableMemoryTokens = policy.contextBudgetTokens
      ? Math.max(
          0,
          policy.contextBudgetTokens -
            (maxOutputTokens ?? 0) -
            estimatedTokens({
              prompt,
              messages: inputMessages,
              systemPrompt: baseSystemPrompt,
            }) -
            64,
        )
      : 0;
    const memoryContext = trimToTokenBudget(
      policy.matterMemoryContext,
      availableMemoryTokens,
    );
    const resolvedSystemPrompt = systemContext(baseSystemPrompt, memoryContext);
    let modelMessages: LocalModelMessage[] | undefined = inputMessages;
    let contextDigestId: string | null = null;
    const inputTokenCount = estimatedTokens({
      prompt,
      messages: inputMessages,
      systemPrompt: resolvedSystemPrompt,
    });
    const compression = policy.contextCompression;
    if (policy.contextBudgetTokens && inputMessages?.length) {
      const primaryThreshold = Math.floor(
        policy.contextBudgetTokens * CONTEXT_COMPRESSION_PRIMARY_THRESHOLD,
      );
      const hygieneThreshold = Math.floor(
        policy.contextBudgetTokens * CONTEXT_COMPRESSION_HYGIENE_THRESHOLD,
      );
      if (inputTokenCount >= primaryThreshold) {
        if (!compression || compression.mode === "Manual") {
          throw new ContextCompressionError(
            "Context reached the compression threshold; manual compression is required before execution can continue.",
            "MANUAL_COMPRESSION_REQUIRED",
          );
        }
        if (compression.mode === "Off") {
          if (inputTokenCount >= hygieneThreshold) {
            throw new ContextCompressionError(
              "Context reached the 85% hygiene threshold while compression is Off.",
              "MANUAL_COMPRESSION_REQUIRED",
            );
          }
        } else {
          if (!compression.modelId || !compression.modelContextWindowTokens) {
            throw new ContextCompressionError(
              "Automatic compression has no healthy local compression model.",
              "COMPRESSION_MODEL_UNAVAILABLE",
            );
          }
          const { head, tailStart } = protectedMessageIndexes(
            inputMessages.length,
          );
          const protectedHead = inputMessages.slice(0, head);
          const protectedTail = inputMessages.slice(tailStart);
          const prepared = prepareCompressibleContext(
            inputMessages.slice(head, tailStart),
          );
          if (!prepared.messages.length) {
            throw new ContextCompressionError(
              "No safe middle context is available for automatic compression.",
              "COMPRESSION_INPUT_TOO_LARGE",
            );
          }
          const sources = compressionSources(prepared.messages, step.runId);
          const compressionPrompt = buildContextDigestPrompt({
            originRun: step.runId,
            messages: prepared.messages,
            sources,
          });
          const digestOutputTokens = Math.min(
            2048,
            Math.max(
              512,
              Math.floor(compression.modelContextWindowTokens * 0.1),
            ),
          );
          if (
            estimatedTokens({ prompt: compressionPrompt }) +
              digestOutputTokens >
            compression.modelContextWindowTokens
          ) {
            throw new ContextCompressionError(
              "Compression input cannot fit inside the configured local compression model.",
              "COMPRESSION_INPUT_TOO_LARGE",
            );
          }
          let digestText: string;
          try {
            digestText = (
              await this.scheduler.generate({
                modelId: compression.modelId,
                prompt: compressionPrompt,
                maxOutputTokens: digestOutputTokens,
                temperature: 0,
                signal: step.signal,
              })
            ).text;
          } catch (error) {
            throw new ContextCompressionError(
              `Local compression model failed: ${error instanceof Error ? error.message : String(error)}`,
              "COMPRESSION_FAILED",
            );
          }
          const digest = parseContextDigest({
            response: digestText,
            originRun: step.runId,
            modelId: compression.modelId,
            modelVersion: compression.modelVersion,
            priorDigestLink: compression.priorDigestLink,
            sources,
            deterministicallyExcludedToolPairs:
              prepared.deterministicallyExcludedToolPairs,
          });
          if (!compression.persistDigest) {
            throw new ContextCompressionError(
              "Automatic compression cannot continue without durable ContextDigest persistence.",
              "COMPRESSION_PERSIST_FAILED",
            );
          }
          try {
            contextDigestId = (await compression.persistDigest(digest)).id;
          } catch (error) {
            throw new ContextCompressionError(
              `ContextDigest persistence failed: ${error instanceof Error ? error.message : String(error)}`,
              "COMPRESSION_PERSIST_FAILED",
            );
          }
          modelMessages = [
            ...protectedHead.map(({ role, content }) => ({ role, content })),
            { role: "system", content: renderContextDigest(digest) },
            ...protectedTail.map(({ role, content }) => ({ role, content })),
          ];
        }
      }
    }
    if (
      policy.contextBudgetTokens &&
      estimatedTokens({
        prompt,
        messages: modelMessages,
        systemPrompt: resolvedSystemPrompt,
      }) +
        (maxOutputTokens ?? 0) >
        policy.contextBudgetTokens
    ) {
      throw new Error(
        "Durable model request exceeds the authoritative context budget",
      );
    }

    const result = await this.scheduler.generate({
      modelId: policy.modelId,
      prompt,
      messages: modelMessages,
      systemPrompt: resolvedSystemPrompt,
      maxOutputTokens,
      temperature:
        typeof step.input.temperature === "number" &&
        Number.isFinite(step.input.temperature)
          ? step.input.temperature
          : undefined,
      reasoningEffort: policy.reasoning?.toLowerCase() as
        | "off"
        | "low"
        | "medium"
        | "high"
        | undefined,
      fastMode: policy.fastMode,
      timeoutMs: optionalNumber(step.input.timeoutMs),
      signal: step.signal,
    });
    const grounded =
      step.handler === LITIGATION_GROUNDED_HANDLER
        ? (() => {
            if (
              typeof step.input.snapshotHash !== "string" ||
              !/^sha256:[a-f0-9]{64}$/.test(step.input.snapshotHash)
            ) {
              throw new Error(
                "Grounded litigation execution requires a valid snapshot hash",
              );
            }
            return parseGroundedLitigationOutput({
              response: result.text,
              allowedSources: Array.isArray(step.input.allowedSources)
                ? step.input.allowedSources
                    .filter(
                      (item): item is Record<string, unknown> =>
                        Boolean(item) &&
                        typeof item === "object" &&
                        !Array.isArray(item),
                    )
                    .map((item) => ({
                      id: typeof item.id === "string" ? item.id : "",
                      quoteSha256:
                        typeof item.quoteSha256 === "string"
                          ? item.quoteSha256
                          : "",
                    }))
                    .filter(
                      (item) =>
                        item.id.length > 0 &&
                        /^[a-f0-9]{64}$/.test(item.quoteSha256),
                    )
                : [],
            });
          })()
        : null;
    const snapshotHash =
      typeof step.input.snapshotHash === "string"
        ? step.input.snapshotHash
        : null;
    return {
      text: grounded ? renderGroundedLitigationOutput(grounded) : result.text,
      modelId: result.modelId,
      providerModel: result.providerModel,
      modelRoutingRole:
        step.handler === LITIGATION_GROUNDED_HANDLER
          ? "litigation_analysis"
          : "routine_analysis",
      estimatedInputTokens: result.estimatedInputTokens,
      outputTokens: result.outputTokens ?? null,
      totalTokens: result.totalTokens ?? null,
      durationMs: result.durationMs,
      matterMemoryIncluded: Boolean(memoryContext),
      matterMemoryTokens: estimatedTokens(memoryContext),
      contextCompressionApplied: Boolean(contextDigestId),
      contextDigestId,
      ...(grounded
        ? {
            structuredOutput: grounded,
            grounding: {
              verified: true,
              exactQuotesVerified: true,
              snapshotHash,
              findingCount: grounded.findings.length,
              citationCount:
                grounded.summaryCitations.length +
                grounded.findings.reduce(
                  (total, finding) => total + finding.citations.length,
                  0,
                ),
              citedSourceIds: [
                ...new Set([
                  ...grounded.summaryCitations.map(
                    (citation) => citation.sourceId,
                  ),
                  ...grounded.findings.flatMap((finding) =>
                    finding.citations.map((citation) => citation.sourceId),
                  ),
                ]),
              ],
            },
          }
        : {}),
    };
  }
}
