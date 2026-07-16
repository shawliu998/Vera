import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolPort,
} from "./assistantRuntime";
import {
  WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
  type WorkspaceAssistantDocumentTools,
} from "./assistantDocumentTools";

const DEFAULT_MAX_TRACKED_REGISTRATIONS = 256;
const MAX_MODULE_ID_CHARS = 160;
const COMPOSED_ADAPTER_ID = "vera-local-assistant-tool-registry-v1";

type AssistantToolExecution = Parameters<AssistantToolPort["execute"]>[0];
type AssistantToolExecutionResult = Awaited<
  ReturnType<AssistantToolPort["execute"]>
>;

/**
 * One independently owned Assistant capability set. Modules never receive a
 * caller-selected route: the registry binds each advertised tool name to its
 * module for one durable job attempt before any execution is accepted.
 */
export interface AssistantToolModule {
  readonly id: string;
  /** Preserve a stable legacy adapter id when this is the sole module. */
  readonly adapterId?: string;
  assertModelUse?(context: AssistantToolContext): void | Promise<void>;
  registeredTools(
    context: AssistantToolContext,
  ): Promise<readonly AssistantToolDefinition[]>;
  execute(input: AssistantToolExecution): Promise<AssistantToolExecutionResult>;
}

export class AssistantToolRegistryError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(message = "Assistant tool registry rejected the operation.") {
    super(message);
    this.name = "AssistantToolRegistryError";
  }
}

type RegisteredRoute = Readonly<{
  jobId: string;
  attempt: number;
  modules: readonly AssistantToolModule[];
  tools: ReadonlyMap<string, AssistantToolModule>;
}>;

type PendingRegistration = Readonly<{
  attempt: number;
  claim: object;
}>;

function executionKey(context: AssistantToolContext) {
  return `${context.jobId}\0${context.attempt}`;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= MAX_MODULE_ID_CHARS
  );
}

/**
 * Fail-closed production composition for Assistant tools. Registrations are
 * fenced to the durable (job id, attempt) pair and bounded like the underlying
 * document adapter's per-generation state.
 */
export class WorkspaceAssistantToolRegistry implements AssistantToolPort {
  private readonly modules: readonly AssistantToolModule[];
  private readonly registrations = new Map<string, RegisteredRoute>();
  private readonly pendingRegistrations = new Map<
    string,
    PendingRegistration
  >();
  private readonly highestAttempts = new Map<string, number>();
  private readonly maxTrackedRegistrations: number;

  constructor(
    modules: readonly AssistantToolModule[],
    options: Readonly<{ maxTrackedRegistrations?: number }> = {},
  ) {
    if (!Array.isArray(modules) || modules.length === 0) {
      throw new AssistantToolRegistryError(
        "Assistant tool registry requires at least one module.",
      );
    }
    const moduleIds = new Set<string>();
    for (const module of modules) {
      if (!module || !validIdentifier(module.id)) {
        throw new AssistantToolRegistryError(
          "Assistant tool module id is invalid.",
        );
      }
      if (moduleIds.has(module.id)) {
        throw new AssistantToolRegistryError(
          "Assistant tool module ids must be unique.",
        );
      }
      moduleIds.add(module.id);
    }
    const limit =
      options.maxTrackedRegistrations ?? DEFAULT_MAX_TRACKED_REGISTRATIONS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_096) {
      throw new AssistantToolRegistryError(
        "Assistant tool registry tracking limit is invalid.",
      );
    }
    this.modules = Object.freeze([...modules]);
    this.maxTrackedRegistrations = limit;
  }

  private activeAttempt(jobId: string) {
    let attempt: number | undefined;
    for (const route of this.registrations.values()) {
      if (route.jobId === jobId) {
        attempt = Math.max(attempt ?? route.attempt, route.attempt);
      }
    }
    return attempt;
  }

  private recordHighestAttempt(jobId: string, attempt: number) {
    const highest = Math.max(
      this.highestAttempts.get(jobId) ?? attempt,
      attempt,
    );
    this.highestAttempts.delete(jobId);
    this.highestAttempts.set(jobId, highest);
    while (this.highestAttempts.size > this.maxTrackedRegistrations) {
      let evicted: string | undefined;
      // Prefer history that still has an active route as a second, bounded
      // guard. If that route is later evicted, its attempt is recorded again.
      for (const candidate of this.highestAttempts.keys()) {
        if (
          this.activeAttempt(candidate) !== undefined ||
          this.pendingRegistrations.has(candidate)
        ) {
          evicted = candidate;
          break;
        }
      }
      evicted ??= this.highestAttempts.keys().next().value as
        | string
        | undefined;
      if (evicted === undefined) break;
      this.highestAttempts.delete(evicted);
    }
  }

  async registeredTools(context: AssistantToolContext) {
    const key = executionKey(context);
    const claim = {};
    const knownAttempt = Math.max(
      this.highestAttempts.get(context.jobId) ?? context.attempt,
      this.activeAttempt(context.jobId) ?? context.attempt,
      this.pendingRegistrations.get(context.jobId)?.attempt ?? context.attempt,
    );
    if (context.attempt < knownAttempt) {
      throw new AssistantToolRegistryError(
        "Assistant tool registration attempt is older than the current job attempt.",
      );
    }
    this.pendingRegistrations.set(context.jobId, {
      attempt: context.attempt,
      claim,
    });
    this.recordHighestAttempt(context.jobId, context.attempt);
    // A newer durable attempt fences every older route for the same job before
    // any asynchronous module registration is allowed to complete.
    for (const [registeredKey, route] of this.registrations) {
      if (route.jobId === context.jobId) {
        this.registrations.delete(registeredKey);
      }
    }
    const tools: AssistantToolDefinition[] = [];
    const toolsByName = new Map<string, AssistantToolModule>();

    try {
      for (const module of this.modules) {
        const moduleTools = await module.registeredTools(context);
        if (!Array.isArray(moduleTools) || moduleTools.length === 0) {
          throw new AssistantToolRegistryError(
            "Assistant tool module registered no tools.",
          );
        }
        for (const tool of moduleTools) {
          const name = tool?.name;
          if (typeof name !== "string" || name.length === 0) {
            throw new AssistantToolRegistryError(
              "Assistant tool module registered an invalid tool name.",
            );
          }
          if (toolsByName.has(name)) {
            throw new AssistantToolRegistryError(
              "Assistant tool names must be globally unique.",
            );
          }
          toolsByName.set(name, module);
          tools.push(tool);
        }
      }

      if (this.pendingRegistrations.get(context.jobId)?.claim !== claim) {
        throw new AssistantToolRegistryError(
          "Assistant tool registration was fenced by a newer job attempt.",
        );
      }
      this.registrations.set(key, {
        jobId: context.jobId,
        attempt: context.attempt,
        modules: this.modules,
        tools: toolsByName,
      });
      while (this.registrations.size > this.maxTrackedRegistrations) {
        const oldest = this.registrations.keys().next().value as
          | string
          | undefined;
        if (oldest === undefined) break;
        const evictedRoute = this.registrations.get(oldest);
        this.registrations.delete(oldest);
        if (evictedRoute) {
          this.recordHighestAttempt(evictedRoute.jobId, evictedRoute.attempt);
        }
      }

      const soleAdapterId =
        this.modules.length === 1 ? this.modules[0]?.adapterId : undefined;
      return {
        adapterId: validIdentifier(soleAdapterId)
          ? soleAdapterId
          : COMPOSED_ADAPTER_ID,
        tools,
      };
    } finally {
      if (this.pendingRegistrations.get(context.jobId)?.claim === claim) {
        this.pendingRegistrations.delete(context.jobId);
      }
    }
  }

  async assertModelUse(context: AssistantToolContext) {
    const route = this.registrations.get(executionKey(context));
    if (!route) {
      throw new AssistantToolRegistryError(
        "Assistant tool registration is missing for this job attempt.",
      );
    }
    for (const module of route.modules) {
      await module.assertModelUse?.(context);
    }
  }

  async execute(input: AssistantToolExecution) {
    const route = this.registrations.get(executionKey(input.context));
    const module = route?.tools.get(input.call.name);
    if (!module) {
      throw new AssistantToolRegistryError(
        "Assistant tool is not registered for this job attempt.",
      );
    }
    // Deliberately forward the original object, including AbortSignal identity.
    return module.execute(input);
  }
}

/** Zero-behaviour-change module boundary around the existing document tools. */
export class WorkspaceAssistantDocumentToolModule implements AssistantToolModule {
  readonly id = "workspace-document-tools";
  readonly adapterId = WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID;

  constructor(private readonly delegate: WorkspaceAssistantDocumentTools) {}

  assertModelUse(context: AssistantToolContext) {
    return this.delegate.assertModelUse(context);
  }

  async registeredTools(context: AssistantToolContext) {
    return (await this.delegate.registeredTools(context)).tools;
  }

  execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    return this.delegate.execute(input);
  }
}
