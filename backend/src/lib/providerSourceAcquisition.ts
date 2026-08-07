import type { AgentStepCapabilityGrantV2 } from "./agent-kernel/capability/stepCapability";
import type {
  ReadOnlySourceExecutionContextV1,
  ReadOnlySourceExecutionOutcomeV1,
} from "./agent-kernel/connectors/readOnlySourceExecution";
import type { ReadOnlySourceRequestV1 } from "./agent-kernel/connectors/readOnlySourceContract";
import {
  executeProviderSourcePipeline,
  type ProviderSourcePipelineOutcomeV1,
} from "./providerSourcePipeline";
import {
  resolveProviderSourceRuntime,
  type ProviderSourceRuntimeV1,
} from "./providerSourceRuntime";
import type { ProviderSourceImportDb } from "./providerSourceImport";

type SupportedOperation = Extract<
  ReadOnlySourceRequestV1["operation"],
  "search" | "read_snapshot"
>;

/**
 * Task-aware, current-user bridge from one fixed connector request to the
 * body-consuming Matter importer. It does not choose a connector, query,
 * jurisdiction, date, result, or mutation target.
 */
export async function executeCurrentUserProviderSourceAcquisition(input: {
  db: ProviderSourceImportDb;
  userId: string;
  matterId: string;
  connectorId: string;
  operation: SupportedOperation;
  context: ReadOnlySourceExecutionContextV1;
  grant: AgentStepCapabilityGrantV2;
  request: ReadOnlySourceRequestV1;
  now?: () => string;
  dependencies?: {
    resolveRuntime?: typeof resolveProviderSourceRuntime;
    executePipeline?: typeof executeProviderSourcePipeline;
  };
}): Promise<ProviderSourcePipelineOutcomeV1> {
  const resolveRuntime =
    input.dependencies?.resolveRuntime ?? resolveProviderSourceRuntime;
  const executePipeline =
    input.dependencies?.executePipeline ?? executeProviderSourcePipeline;
  const runtime = await resolveRuntime({
    connectorId: input.connectorId,
    operation: input.operation,
    userId: input.userId,
    db: input.db as never,
    now: input.now,
  });
  return executePipeline({
    db: input.db,
    userId: input.userId,
    matterId: input.matterId,
    execution: {
      context: input.context,
      grant: input.grant,
      pin: runtime.pin,
      authorization: runtime.authorization,
      request: input.request,
      invoker: runtime.invoker,
      normalizer: runtime.normalizer,
      now: input.now,
    },
  });
}

export type ProviderSourceAcquisitionInterruptedV1 = Exclude<
  ReadOnlySourceExecutionOutcomeV1,
  { kind: "completed" }
>;
export type { ProviderSourceRuntimeV1 };
