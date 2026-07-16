import assert from "node:assert/strict";

import {
  WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
  type WorkspaceAssistantDocumentTools,
} from "../lib/workspace/services/assistantDocumentTools";
import {
  AssistantToolRegistryError,
  WorkspaceAssistantDocumentToolModule,
  WorkspaceAssistantToolRegistry,
  type AssistantToolModule,
} from "../lib/workspace/services/assistantToolRegistry";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
} from "../lib/workspace/services/assistantRuntime";

const LIST_TOOL: AssistantToolDefinition = Object.freeze({
  name: "list_documents",
  description: "List documents.",
  inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
});
const READ_TOOL: AssistantToolDefinition = Object.freeze({
  name: "read_document",
  description: "Read a document.",
  inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
});

function context(jobId: string, attempt = 1): AssistantToolContext {
  return {
    jobId,
    attempt,
    chatId: `chat-${jobId}`,
    projectId: null,
    modelProfileId: "model-profile",
    documents: [],
  };
}

function call(
  name: AssistantModelToolCall["name"] = "list_documents",
): AssistantModelToolCall {
  return { id: `call-${name}`, name, input: {} };
}

function module(input: {
  id: string;
  adapterId?: string;
  tools?: readonly AssistantToolDefinition[];
  assertModelUse?: AssistantToolModule["assertModelUse"];
  execute?: AssistantToolModule["execute"];
}): AssistantToolModule {
  return {
    id: input.id,
    adapterId: input.adapterId,
    assertModelUse: input.assertModelUse,
    async registeredTools() {
      return input.tools ?? [LIST_TOOL];
    },
    async execute(execution) {
      return input.execute?.(execution) ?? { content: "ok" };
    },
  };
}

async function assertConstructionFailsClosed() {
  assert.throws(
    () => new WorkspaceAssistantToolRegistry([]),
    AssistantToolRegistryError,
  );
  assert.throws(
    () => new WorkspaceAssistantToolRegistry([module({ id: "" })]),
    /module id is invalid/i,
  );
  assert.throws(
    () => new WorkspaceAssistantToolRegistry([module({ id: " padded " })]),
    /module id is invalid/i,
  );
  assert.throws(
    () =>
      new WorkspaceAssistantToolRegistry([
        module({ id: "duplicate" }),
        module({ id: "duplicate", tools: [READ_TOOL] }),
      ]),
    /module ids must be unique/i,
  );
  assert.throws(
    () =>
      new WorkspaceAssistantToolRegistry([module({ id: "documents" })], {
        maxTrackedRegistrations: 0,
      }),
    /tracking limit is invalid/i,
  );
}

async function assertRegistrationFailsClosed() {
  const emptyModule = module({ id: "empty", tools: [] });
  await assert.rejects(
    new WorkspaceAssistantToolRegistry([emptyModule]).registeredTools(
      context("empty"),
    ),
    /registered no tools/i,
  );

  const duplicateRegistry = new WorkspaceAssistantToolRegistry([
    module({ id: "first" }),
    module({ id: "second" }),
  ]);
  await assert.rejects(
    duplicateRegistry.registeredTools(context("duplicate-tools")),
    /globally unique/i,
  );

  let definitions: readonly AssistantToolDefinition[] = [LIST_TOOL];
  const mutableModule: AssistantToolModule = {
    id: "mutable",
    async registeredTools() {
      return definitions;
    },
    async execute() {
      return { content: "should-not-run-after-failed-refresh" };
    },
  };
  const refreshRegistry = new WorkspaceAssistantToolRegistry([mutableModule]);
  const refreshContext = context("refresh");
  await refreshRegistry.registeredTools(refreshContext);
  definitions = [];
  await assert.rejects(
    refreshRegistry.registeredTools(refreshContext),
    /registered no tools/i,
  );
  await assert.rejects(
    refreshRegistry.execute({
      context: refreshContext,
      call: call(),
      signal: new AbortController().signal,
    }),
    /not registered for this job attempt/i,
  );
}

async function assertExactAttemptRouting() {
  const registry = new WorkspaceAssistantToolRegistry([
    module({
      id: "documents",
      adapterId: WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
    }),
  ]);
  const attemptOne = context("route-job", 1);
  const registration = await registry.registeredTools(attemptOne);
  assert.equal(
    registration.adapterId,
    WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
  );
  assert.deepEqual(registration.tools, [LIST_TOOL]);
  assert.deepEqual(
    await registry.execute({
      context: attemptOne,
      call: call(),
      signal: new AbortController().signal,
    }),
    { content: "ok" },
  );
  const attemptTwo = context("route-job", 2);
  await registry.registeredTools(attemptTwo);
  await assert.rejects(
    registry.execute({
      context: attemptOne,
      call: call(),
      signal: new AbortController().signal,
    }),
    /not registered for this job attempt/i,
  );
  assert.equal(
    (
      await registry.execute({
        context: attemptTwo,
        call: call(),
        signal: new AbortController().signal,
      })
    ).content,
    "ok",
  );
  await assert.rejects(
    registry.execute({
      context: attemptTwo,
      call: call("read_document"),
      signal: new AbortController().signal,
    }),
    /not registered for this job attempt/i,
  );
  await assert.rejects(
    registry.assertModelUse(context("never-registered")),
    /registration is missing/i,
  );
}

async function assertDocumentWrapperPreservesDelegateBehaviour() {
  const toolContext = context("document-wrapper");
  const controller = new AbortController();
  let assertedContext: AssistantToolContext | null = null;
  let registeredContext: AssistantToolContext | null = null;
  let executionInput: Parameters<AssistantToolModule["execute"]>[0] | null =
    null;
  const delegate = {
    assertModelUse(value: AssistantToolContext) {
      assertedContext = value;
    },
    async registeredTools(value: AssistantToolContext) {
      registeredContext = value;
      return {
        adapterId: WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
        tools: [LIST_TOOL],
      };
    },
    async execute(value: Parameters<AssistantToolModule["execute"]>[0]) {
      executionInput = value;
      return { content: "delegate-result" };
    },
  } as unknown as WorkspaceAssistantDocumentTools;
  const registry = new WorkspaceAssistantToolRegistry([
    new WorkspaceAssistantDocumentToolModule(delegate),
  ]);
  const registration = await registry.registeredTools(toolContext);
  assert.equal(registeredContext, toolContext);
  assert.equal(
    registration.adapterId,
    WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
  );
  assert.deepEqual(registration.tools, [LIST_TOOL]);
  await registry.assertModelUse(toolContext);
  assert.equal(assertedContext, toolContext);
  const execution = {
    context: toolContext,
    call: call(),
    signal: controller.signal,
  };
  assert.deepEqual(await registry.execute(execution), {
    content: "delegate-result",
  });
  assert.equal(executionInput, execution);
}

async function assertConcurrentOlderAttemptCannotReopenRoute() {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const delayedModule: AssistantToolModule = {
    id: "delayed",
    async registeredTools(toolContext) {
      if (toolContext.attempt === 1) await firstGate;
      return [LIST_TOOL];
    },
    async execute() {
      return { content: "current-attempt" };
    },
  };
  const registry = new WorkspaceAssistantToolRegistry([delayedModule]);
  const attemptOne = context("concurrent-route-job", 1);
  const attemptTwo = context("concurrent-route-job", 2);
  const staleRegistration = registry.registeredTools(attemptOne);
  await registry.registeredTools(attemptTwo);
  releaseFirst();
  await assert.rejects(staleRegistration, /fenced by a newer job attempt/i);
  await assert.rejects(
    registry.execute({
      context: attemptOne,
      call: call(),
      signal: new AbortController().signal,
    }),
    /not registered for this job attempt/i,
  );
  assert.equal(
    (
      await registry.execute({
        context: attemptTwo,
        call: call(),
        signal: new AbortController().signal,
      })
    ).content,
    "current-attempt",
  );
}

async function assertCompletedNewerAttemptRejectsLateOlderRegistration() {
  const registry = new WorkspaceAssistantToolRegistry([
    module({ id: "monotonic-attempt" }),
  ]);
  const attemptOne = context("reverse-order-job", 1);
  const attemptTwo = context("reverse-order-job", 2);
  await registry.registeredTools(attemptTwo);
  await assert.rejects(
    registry.registeredTools(attemptOne),
    /older than the current job attempt/i,
  );
  assert.equal(
    (
      await registry.execute({
        context: attemptTwo,
        call: call(),
        signal: new AbortController().signal,
      })
    ).content,
    "ok",
  );
  await assert.rejects(
    registry.execute({
      context: attemptOne,
      call: call(),
      signal: new AbortController().signal,
    }),
    /not registered for this job attempt/i,
  );
}

async function assertAbortAndErrorsPassThrough() {
  let receivedSignal: AbortSignal | null = null;
  const expectedFailure = new Error("module failure identity");
  const cancellationRegistry = new WorkspaceAssistantToolRegistry([
    module({
      id: "cancellable",
      async execute(input) {
        receivedSignal = input.signal;
        if (input.signal.aborted) {
          const error = new Error("cancelled by caller");
          error.name = "AbortError";
          throw error;
        }
        throw expectedFailure;
      },
    }),
  ]);
  const toolContext = context("abort-job");
  await cancellationRegistry.registeredTools(toolContext);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cancellationRegistry.execute({
      context: toolContext,
      call: call(),
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(receivedSignal, controller.signal);

  const liveSignal = new AbortController().signal;
  await assert.rejects(
    cancellationRegistry.execute({
      context: toolContext,
      call: call(),
      signal: liveSignal,
    }),
    (error: unknown) => error === expectedFailure,
  );
  assert.equal(receivedSignal, liveSignal);
}

async function assertModelPolicyAndBoundedEviction() {
  const asserted: string[] = [];
  const registry = new WorkspaceAssistantToolRegistry(
    [
      module({
        id: "bounded",
        assertModelUse(toolContext) {
          asserted.push(`${toolContext.jobId}:${toolContext.attempt}`);
        },
      }),
    ],
    { maxTrackedRegistrations: 2 },
  );
  const first = context("first");
  const second = context("second");
  const third = context("third");
  await registry.registeredTools(first);
  await registry.registeredTools(second);
  await registry.assertModelUse(second);
  assert.deepEqual(asserted, ["second:1"]);
  await registry.registeredTools(third);
  await assert.rejects(
    registry.execute({
      context: first,
      call: call(),
      signal: new AbortController().signal,
    }),
    /not registered for this job attempt/i,
  );
  assert.equal(
    (
      await registry.execute({
        context: second,
        call: call(),
        signal: new AbortController().signal,
      })
    ).content,
    "ok",
  );
  assert.equal(
    (
      await registry.execute({
        context: third,
        call: call(),
        signal: new AbortController().signal,
      })
    ).content,
    "ok",
  );
}

async function main() {
  await assertConstructionFailsClosed();
  await assertRegistrationFailsClosed();
  await assertExactAttemptRouting();
  await assertDocumentWrapperPreservesDelegateBehaviour();
  await assertConcurrentOlderAttemptCannotReopenRoute();
  await assertCompletedNewerAttemptRejectsLateOlderRegistration();
  await assertAbortAndErrorsPassThrough();
  await assertModelPolicyAndBoundedEviction();
  console.log("Vera Workspace Assistant Tool Registry audit passed.");
}

void main();
