import { z } from "zod";

import { WorkspaceApiError } from "../errors";
import { assertMikeSafePayload } from "../mikeCompatibility";
import { WorkspaceModelProviderRegistry } from "../modelProviderRegistry";
import type { ModelGenerateRequest } from "../providers";
import type { AssistantRetrievalChunk } from "../repositories/assistantRetrieval";
import {
  ModelProfilesRepository,
  type StoredModelProfileRecord,
} from "../repositories/modelProfiles";
import type {
  AssistantModelMessage,
  AssistantModelPort,
  AssistantModelTurn,
  AssistantToolName,
} from "./assistantRuntime";
import { buildEndpointBindingSnapshot } from "./modelGateway";
import {
  assertInferenceAllowed,
  type InferencePolicyEnforcementPort,
} from "../inferencePolicy";

const CITATIONS_OPEN = "<CITATIONS>";
const CITATIONS_CLOSE = "</CITATIONS>";
const MAX_CITATION_JSON_CHARS = 100_000;
const MAX_TOOL_ARGUMENT_CHARS = 100_000;
const MAX_TOOL_CALLS = 16;
const MAX_PROVIDER_EVENT_TEXT_CHARS = 200_000;
const MAX_PROVIDER_REASONING_CHARS = 200_000;
const MAX_PROVIDER_TOKEN_COUNT = 2_147_483_647;
const MAX_USAGE_DIAGNOSTICS = 128;

const CitationPage = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d{1,6}\s*-\s*\d{1,6}$/)
    .max(20),
]);
const CitationProtocol = z
  .array(
    z
      .object({
        ref: z.number().int().positive().max(200),
        doc_id: z.string().regex(/^doc-(?:0|[1-9]\d{0,2})$/),
        quotes: z
          .array(
            z
              .object({
                page: CitationPage.optional(),
                quote: z
                  .string()
                  .min(1)
                  .max(8_000)
                  .refine((value) => value.trim().length > 0),
              })
              .strict(),
          )
          .length(1),
      })
      .strict(),
  )
  .max(200);

class AssistantProviderError extends Error {
  constructor(
    readonly code:
      | "assistant_model_failed"
      | "assistant_timeout"
      | "assistant_rate_limited"
      | "assistant_context_limit"
      | "assistant_output_invalid",
    readonly retryable: boolean,
  ) {
    super("Assistant model provider failed.");
    this.name = "AssistantProviderError";
  }
}

function providerFailure(code: string, retryable: boolean) {
  const normalized = code.toLowerCase();
  if (/(?:rate|quota|429)/.test(normalized)) {
    return new AssistantProviderError("assistant_rate_limited", true);
  }
  if (/(?:context|token_limit|too_large)/.test(normalized)) {
    return new AssistantProviderError("assistant_context_limit", false);
  }
  if (/(?:timeout|timed_out)/.test(normalized)) {
    return new AssistantProviderError("assistant_timeout", true);
  }
  if (/(?:invalid|protocol|malformed|parse)/.test(normalized)) {
    return new AssistantProviderError("assistant_output_invalid", false);
  }
  return new AssistantProviderError("assistant_model_failed", retryable);
}

function toolHistory(message: AssistantModelMessage) {
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return message.content;
  }
  const calls = message.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    input: call.input,
  }));
  assertMikeSafePayload(calls);
  return `${message.content}\n\n[Assistant tool calls]\n${JSON.stringify(calls)}`;
}

function pageRange(value: z.infer<typeof CitationPage> | undefined) {
  if (value === undefined) return null;
  if (typeof value === "number") return [value, value] as const;
  const [start, end] = value.split("-").map((part) => Number(part.trim()));
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    end < start
  ) {
    throw new AssistantProviderError("assistant_output_invalid", false);
  }
  return [start, end] as const;
}

function citationSources(input: {
  raw: string | null;
  documents: readonly {
    documentId: string;
    versionId: string;
    attached: boolean;
  }[];
  evidence: readonly AssistantRetrievalChunk[];
}): AssistantModelTurn["sources"] {
  if (input.raw === null) return [];
  if (input.raw.length > MAX_CITATION_JSON_CHARS) {
    throw new AssistantProviderError("assistant_output_invalid", false);
  }
  let parsed: z.infer<typeof CitationProtocol>;
  try {
    parsed = CitationProtocol.parse(JSON.parse(input.raw));
    assertMikeSafePayload(parsed);
  } catch {
    throw new AssistantProviderError("assistant_output_invalid", false);
  }
  const expectedRefs = parsed.map((_, index) => index + 1);
  if (parsed.some((citation, index) => citation.ref !== expectedRefs[index])) {
    throw new AssistantProviderError("assistant_output_invalid", false);
  }
  return parsed.map((citation, index) => {
    const documentIndex = Number(citation.doc_id.slice("doc-".length));
    const document = input.documents[documentIndex];
    if (!document) {
      throw new AssistantProviderError("assistant_output_invalid", false);
    }
    const quote = citation.quotes[0];
    const requestedPage = pageRange(quote.page);
    const matches: Array<{
      chunk: AssistantRetrievalChunk;
      relativeStart: number;
    }> = [];
    for (const chunk of input.evidence) {
      if (
        chunk.documentId !== document.documentId ||
        chunk.versionId !== document.versionId
      ) {
        continue;
      }
      if (requestedPage) {
        if (chunk.pageStart === null) continue;
        const chunkStart = chunk.pageStart;
        const chunkEnd = chunk.pageEnd ?? chunkStart;
        if (requestedPage[0] < chunkStart || requestedPage[1] > chunkEnd) {
          continue;
        }
      }
      let from = 0;
      while (from <= chunk.text.length - quote.quote.length) {
        const relativeStart = chunk.text.indexOf(quote.quote, from);
        if (relativeStart < 0) break;
        matches.push({ chunk, relativeStart });
        from = relativeStart + Math.max(quote.quote.length, 1);
      }
    }
    if (matches.length !== 1) {
      throw new AssistantProviderError("assistant_output_invalid", false);
    }
    const { chunk, relativeStart } = matches[0];
    const startOffset = chunk.startOffset + relativeStart;
    const endOffset = startOffset + quote.quote.length;
    // Page/offset locators are derived from the stable chunk selected by exact
    // quote matching. The model-supplied page is only a narrowing assertion;
    // it is never persisted as authority.
    const locatorPage =
      chunk.pageStart === null
        ? null
        : ([chunk.pageStart, chunk.pageEnd ?? chunk.pageStart] as const);
    return {
      documentId: chunk.documentId,
      versionId: chunk.versionId,
      chunkId: chunk.chunkId,
      quote: quote.quote,
      startOffset,
      endOffset,
      locator: {
        ...(locatorPage
          ? { pageStart: locatorPage[0], pageEnd: locatorPage[1] }
          : {}),
        startOffset,
        endOffset,
      },
      rank: index,
      score: chunk.score,
      citationOrdinal: index,
      citationMetadata: { citationNumber: citation.ref },
    };
  });
}

export type WorkspaceAssistantModelAdapterOptions = Readonly<{
  allowLocalDevelopmentBaseUrl?: boolean;
  clock?: () => Date;
  inferencePolicy?: InferencePolicyEnforcementPort;
}>;

export type AssistantProviderUsageDiagnostic = Readonly<{
  profileId: string;
  provider: StoredModelProfileRecord["provider"];
  executionRevision: number;
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  observedAt: string;
}>;

/**
 * Binds the audited provider registry to the existing AssistantModelPort.
 * Mike's hidden <CITATIONS> trailer is consumed here and never emitted as
 * visible content; exact quotes are resolved only against tool evidence.
 */
export class WorkspaceAssistantModelAdapter implements AssistantModelPort {
  private readonly allowLocalDevelopmentBaseUrl: boolean;
  private readonly clock: () => Date;
  private readonly inferencePolicy: InferencePolicyEnforcementPort | null;
  private readonly usageHistory: AssistantProviderUsageDiagnostic[] = [];

  constructor(
    private readonly profiles: ModelProfilesRepository,
    private readonly registry: WorkspaceModelProviderRegistry,
    options: WorkspaceAssistantModelAdapterOptions = {},
  ) {
    this.allowLocalDevelopmentBaseUrl =
      options.allowLocalDevelopmentBaseUrl ?? false;
    this.clock = options.clock ?? (() => new Date());
    this.inferencePolicy = options.inferencePolicy ?? null;
  }

  /** Bounded, process-local, secret-free provider usage diagnostics. */
  usageDiagnostics(): readonly AssistantProviderUsageDiagnostic[] {
    return this.usageHistory.map((record) => ({ ...record }));
  }

  private recordUsage(
    profile: StoredModelProfileRecord,
    inputTokenCount: number | undefined,
    outputTokenCount: number | undefined,
  ) {
    this.usageHistory.push({
      profileId: profile.id,
      provider: profile.provider,
      executionRevision: profile.executionRevision,
      inputTokenCount: inputTokenCount ?? null,
      outputTokenCount: outputTokenCount ?? null,
      observedAt: this.clock().toISOString(),
    });
    if (this.usageHistory.length > MAX_USAGE_DIAGNOSTICS) {
      this.usageHistory.splice(
        0,
        this.usageHistory.length - MAX_USAGE_DIAGNOSTICS,
      );
    }
  }

  private profile(profileId: string) {
    const ready = this.profiles.requireEnabled(profileId);
    const profile = this.profiles.requireStored(profileId);
    if (
      !profile.enabled ||
      ready.id !== profile.id ||
      ready.provider !== profile.provider ||
      ready.model !== profile.model ||
      ready.baseUrl !== profile.baseUrl
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Assistant model profile changed before execution.",
      );
    }
    if (!this.registry.runtimeWired()) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant model provider runtime is unavailable.",
      );
    }
    const capabilities = this.registry.capabilitiesFor(profile.provider);
    if (
      !capabilities?.streaming ||
      !capabilities.toolCalling ||
      !profile.capabilities.streaming ||
      !profile.capabilities.toolCalling
    ) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant model profile lacks streaming tool capability.",
      );
    }
    return profile;
  }

  async registeredCapabilities(input: { modelProfileId: string }) {
    const profile = this.profile(input.modelProfileId);
    return {
      adapterId: `vera-provider-${profile.provider}-r${profile.executionRevision}`,
      streaming: true,
      toolCalling: true,
      reasoning: false,
    };
  }

  async runTurn(
    input: Parameters<AssistantModelPort["runTurn"]>[0],
  ): Promise<AssistantModelTurn> {
    const profile = this.profile(input.modelProfileId);
    const expectedBinding = buildEndpointBindingSnapshot(
      profile,
      this.allowLocalDevelopmentBaseUrl,
    );
    const provider = this.registry.createProvider({
      profile,
      expectedBinding,
      allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
    });
    const request: ModelGenerateRequest = {
      model: profile.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        ...input.messages.map((message) => ({
          role: message.role,
          content: toolHistory(message),
        })),
      ],
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: { ...tool.inputSchema },
        strict: true,
      })),
      ...(profile.maxOutputTokens
        ? { maxOutputTokens: profile.maxOutputTokens }
        : {}),
      responseFormat: { type: "text" },
      metadata: { feature: "vera_assistant" },
    };
    // Token limits are non-secret provider controls, but the generic Mike
    // transport guard intentionally rejects any key containing "token". Check
    // every user/model-derived portion instead of weakening that guard.
    assertMikeSafePayload({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      responseFormat: request.responseFormat,
      metadata: request.metadata,
    });

    // Re-evaluate at the last synchronous boundary. Queue-time policy is only
    // a preflight; declarations or Matter policy may change while a job waits.
    if (!this.inferencePolicy) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Inference policy runtime is unavailable.",
      );
    }
    assertInferenceAllowed(this.inferencePolicy, {
      projectId: input.projectId,
      modelProfileId: input.modelProfileId,
      operation: input.operation,
      sourceSnapshotIds: input.documents.map((document) => document.versionId),
    });

    const toolCalls = new Map<
      string,
      { id: string; name: string; argumentsText: string; ended: boolean }
    >();
    const allowedToolNames = new Set(input.tools.map((tool) => tool.name));
    let visible = "";
    let pendingVisible = "";
    let hidden = "";
    let afterClose = "";
    let sawOpen = false;
    let sawClose = false;
    let completed = false;
    let reasoningOpen = false;
    let providerTextChars = 0;
    let providerReasoningChars = 0;
    let sawUsage = false;

    if (
      allowedToolNames.size !== input.tools.length ||
      allowedToolNames.size > MAX_TOOL_CALLS
    ) {
      throw new AssistantProviderError("assistant_output_invalid", false);
    }

    const closeReasoning = async () => {
      if (!reasoningOpen) return;
      reasoningOpen = false;
      await input.onReasoningBlockEnd();
    };
    const emitVisible = async (text: string) => {
      if (!text) return;
      visible += text;
      await input.onTextDelta(text);
    };
    const consumeText = async (delta: string) => {
      if (typeof delta !== "string") {
        throw new AssistantProviderError("assistant_output_invalid", false);
      }
      providerTextChars += delta.length;
      if (providerTextChars > MAX_PROVIDER_EVENT_TEXT_CHARS) {
        throw new AssistantProviderError("assistant_output_invalid", false);
      }
      await closeReasoning();
      if (sawClose) {
        afterClose += delta;
        return;
      }
      if (sawOpen) {
        hidden += delta;
        const closeIndex = hidden.indexOf(CITATIONS_CLOSE);
        if (closeIndex >= 0) {
          afterClose += hidden.slice(closeIndex + CITATIONS_CLOSE.length);
          hidden = hidden.slice(0, closeIndex);
          sawClose = true;
        }
        return;
      }
      pendingVisible += delta;
      const openIndex = pendingVisible.indexOf(CITATIONS_OPEN);
      if (openIndex >= 0) {
        await emitVisible(pendingVisible.slice(0, openIndex));
        hidden = pendingVisible.slice(openIndex + CITATIONS_OPEN.length);
        pendingVisible = "";
        sawOpen = true;
        const closeIndex = hidden.indexOf(CITATIONS_CLOSE);
        if (closeIndex >= 0) {
          afterClose = hidden.slice(closeIndex + CITATIONS_CLOSE.length);
          hidden = hidden.slice(0, closeIndex);
          sawClose = true;
        }
        return;
      }
      const keep = Math.min(CITATIONS_OPEN.length - 1, pendingVisible.length);
      const flush = pendingVisible.slice(0, pendingVisible.length - keep);
      pendingVisible = pendingVisible.slice(pendingVisible.length - keep);
      await emitVisible(flush);
    };

    for await (const event of provider.generate(request, input.signal)) {
      if (completed) {
        throw new AssistantProviderError("assistant_output_invalid", false);
      }
      switch (event.type) {
        case "text_delta":
          await consumeText(event.text);
          break;
        case "reasoning_delta":
          if (typeof event.text !== "string") {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          providerReasoningChars += event.text.length;
          if (providerReasoningChars > MAX_PROVIDER_REASONING_CHARS) {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          reasoningOpen = true;
          await input.onReasoningDelta(event.text);
          break;
        case "tool_call_start":
          await closeReasoning();
          if (
            typeof event.id !== "string" ||
            event.id.length < 1 ||
            event.id.length > 160 ||
            typeof event.name !== "string" ||
            !allowedToolNames.has(event.name as AssistantToolName) ||
            toolCalls.has(event.id) ||
            toolCalls.size >= MAX_TOOL_CALLS ||
            sawOpen
          ) {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          toolCalls.set(event.id, {
            id: event.id,
            name: event.name,
            argumentsText: "",
            ended: false,
          });
          break;
        case "tool_call_delta": {
          const call = toolCalls.get(event.id);
          if (!call || call.ended || typeof event.argumentsDelta !== "string") {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          call.argumentsText += event.argumentsDelta;
          if (call.argumentsText.length > MAX_TOOL_ARGUMENT_CHARS) {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          break;
        }
        case "tool_call_end": {
          const call = toolCalls.get(event.id);
          if (!call || call.ended) {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          call.ended = true;
          break;
        }
        case "usage":
          if (
            sawUsage ||
            (event.inputTokens !== undefined &&
              (!Number.isSafeInteger(event.inputTokens) ||
                event.inputTokens < 0 ||
                event.inputTokens > MAX_PROVIDER_TOKEN_COUNT)) ||
            (event.outputTokens !== undefined &&
              (!Number.isSafeInteger(event.outputTokens) ||
                event.outputTokens < 0 ||
                event.outputTokens > MAX_PROVIDER_TOKEN_COUNT))
          ) {
            throw new AssistantProviderError("assistant_output_invalid", false);
          }
          sawUsage = true;
          this.recordUsage(profile, event.inputTokens, event.outputTokens);
          break;
        case "completed":
          await closeReasoning();
          completed = true;
          break;
        case "error":
          throw providerFailure(event.code, event.retryable);
      }
    }
    if (!completed) {
      throw new AssistantProviderError("assistant_output_invalid", false);
    }
    if (!sawOpen) {
      await emitVisible(pendingVisible);
      pendingVisible = "";
    } else if (!sawClose) {
      throw new AssistantProviderError("assistant_output_invalid", false);
    }
    if (afterClose.trim().length > 0) {
      throw new AssistantProviderError("assistant_output_invalid", false);
    }

    const calls = [...toolCalls.values()].map((call) => {
      if (!call.ended) {
        throw new AssistantProviderError("assistant_output_invalid", false);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.argumentsText || "{}");
      } catch {
        throw new AssistantProviderError("assistant_output_invalid", false);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new AssistantProviderError("assistant_output_invalid", false);
      }
      assertMikeSafePayload(parsed);
      return {
        id: call.id,
        name: call.name as AssistantToolName,
        input: parsed as Record<string, unknown>,
      };
    });
    const sources = citationSources({
      raw: sawOpen ? hidden.trim() : null,
      documents: input.documents,
      evidence: input.evidence,
    });
    const turn = { content: visible, toolCalls: calls, sources };
    assertMikeSafePayload(turn);
    return turn;
  }
}
