import { z } from "zod";

import {
  executeReadOnlySourceConnector,
  type ReadOnlySourceExecutionOutcomeV1,
} from "./agent-kernel/connectors/readOnlySourceExecution";
import {
  importProviderSourceSnapshot,
  type ProviderSourceImportDb,
  type ProviderSourceImportDependencies,
  type ProviderSourceImportReceiptV1,
} from "./providerSourceImport";
import { sameUuidIdentity } from "./uuidIdentity";

type ConnectorExecutionInput = Parameters<
  typeof executeReadOnlySourceConnector
>[0];

type InterruptedOutcome = Exclude<
  ReadOnlySourceExecutionOutcomeV1,
  { kind: "completed" }
>;

export type ProviderSourcePipelineOutcomeV1 =
  | InterruptedOutcome
  | {
      kind: "completed";
      operation: "search";
      discoveries: Extract<
        ReadOnlySourceExecutionOutcomeV1,
        { kind: "completed" }
      >["discoveries"];
      coverage: Extract<
        ReadOnlySourceExecutionOutcomeV1,
        { kind: "completed" }
      >["coverage"];
      receipt: Extract<
        ReadOnlySourceExecutionOutcomeV1,
        { kind: "completed" }
      >["receipt"];
      imports: [];
    }
  | {
      kind: "completed";
      operation: "read_snapshot";
      discoveries: [];
      coverage: Extract<
        ReadOnlySourceExecutionOutcomeV1,
        { kind: "completed" }
      >["coverage"];
      receipt: Extract<
        ReadOnlySourceExecutionOutcomeV1,
        { kind: "completed" }
      >["receipt"];
      imports: ProviderSourceImportReceiptV1[];
    };

export class ProviderSourcePipelineError extends Error {
  constructor(readonly code: "scope_invalid" | "operation_contract_invalid") {
    super(`provider_source_pipeline_${code}`);
    this.name = "ProviderSourcePipelineError";
  }
}

/**
 * Server-owned seam between external discovery/read and Matter persistence.
 * Body-bearing snapshots are consumed here and deliberately absent from the
 * returned outcome, so callers cannot accidentally persist them in Task state.
 */
export async function executeProviderSourcePipeline(input: {
  db: ProviderSourceImportDb;
  userId: string;
  matterId: string;
  execution: ConnectorExecutionInput;
  dependencies?: {
    import?: typeof importProviderSourceSnapshot;
    importDependencies?: ProviderSourceImportDependencies;
  };
}): Promise<ProviderSourcePipelineOutcomeV1> {
  if (
    !z.string().uuid().safeParse(input.userId).success ||
    !z.string().uuid().safeParse(input.matterId).success ||
    !sameUuidIdentity(input.execution.context.matterId, input.matterId)
  ) {
    throw new ProviderSourcePipelineError("scope_invalid");
  }

  const executed = await executeReadOnlySourceConnector(input.execution);
  if (executed.kind !== "completed") return executed;

  if (executed.receipt.operation === "search") {
    if (executed.importCandidates.length) {
      throw new ProviderSourcePipelineError("operation_contract_invalid");
    }
    return {
      kind: "completed",
      operation: "search",
      discoveries: executed.discoveries,
      coverage: executed.coverage,
      receipt: executed.receipt,
      imports: [],
    };
  }

  if (
    executed.receipt.operation !== "read_snapshot" ||
    executed.discoveries.length ||
    executed.importCandidates.length > 1
  ) {
    throw new ProviderSourcePipelineError("operation_contract_invalid");
  }

  const importer = input.dependencies?.import ?? importProviderSourceSnapshot;
  const imports: ProviderSourceImportReceiptV1[] = [];
  for (const snapshot of executed.importCandidates) {
    imports.push(
      await importer({
        db: input.db,
        userId: input.userId,
        matterId: input.matterId,
        snapshot,
        connectorReceipt: executed.receipt,
        dependencies: input.dependencies?.importDependencies,
      }),
    );
  }
  return {
    kind: "completed",
    operation: "read_snapshot",
    discoveries: [],
    coverage: executed.coverage,
    receipt: executed.receipt,
    imports,
  };
}
