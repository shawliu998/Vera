import type { AgentStepCapabilityGrantV2 } from "./agent-kernel/capability/stepCapability";
import type { AgentStepContractV1 } from "./agent-kernel/contracts/stepContract";
import { readFixedMatterContext } from "./agent-kernel/context/matterContext";
import type { AgentTaskExecutionPauseClassification } from "./agent-kernel/outcomes/executionOutcome";
import {
  AgentTaskExecutionInterruptedError,
  type AgentStepExecutionResult,
} from "./agentStepExecutor";
import {
  compileProviderSourceSearchRequest,
  executeCurrentUserProviderSourceAcquisition,
} from "./providerSourceAcquisition";
import {
  PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY,
  appendProviderSourceSearchPage,
  compileNextProviderSourceSelectedRead,
  providerSourceAcquisitionStateSchema,
  recordProviderSourceSelectedRead,
} from "./providerSourceAcquisitionState";
import type { ProviderSourceImportDb } from "./providerSourceImport";

type Snapshot = {
  task: {
    id: string;
    matter_id: string;
    latest_checkpoint?: unknown;
  };
};

export type AgentSourceAcquisitionExecutionOutcomeV1 =
  | { kind: "execution"; result: AgentStepExecutionResult }
  | {
      kind: "provider_pause";
      classification: AgentTaskExecutionPauseClassification;
      checkpointValues: { source_acquisition: unknown };
    };

function readState(snapshot: Snapshot) {
  const checkpoint =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? (snapshot.task.latest_checkpoint as Record<string, unknown>)
      : null;
  if (!checkpoint) throw new Error("Source acquisition checkpoint is missing");
  return providerSourceAcquisitionStateSchema.parse(
    checkpoint[PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY],
  );
}

function requestRef(input: {
  stepId: string;
  attempt: number;
  operation: "search" | "read";
  sequence: number;
}) {
  return `${input.stepId}:a${input.attempt}:${input.operation}:${input.sequence}`;
}

function executionResult(
  state: ReturnType<typeof providerSourceAcquisitionStateSchema.parse>,
): AgentStepExecutionResult {
  const imports = state.import_receipts;
  const summary =
    state.phase === "completed"
      ? `Imported ${imports.length} lawyer-selected provider source${imports.length === 1 ? "" : "s"} as current Matter document versions.`
      : state.phase === "selection_required"
        ? `Provider search returned ${state.discoveries.length} bounded non-citable result${state.discoveries.length === 1 ? "" : "s"}. Select up to ${state.spec.maximum_selections} to import into this Matter.`
        : `Source acquisition requires lawyer review: ${state.issues.map((issue) => issue.detail).join(" ")}`;
  return {
    summary,
    artifacts: imports.map((receipt) => ({
      artifact_type: "document" as const,
      artifact_id: receipt.document_id,
      purpose: "Acquired source document",
    })),
    waitingForInput: state.phase !== "completed",
    requiredInput: null,
    citationCheck: { total: 0, relocatable: 0, missing: 0 },
    checkpointValues: { source_acquisition: state },
  };
}

export async function executeAgentSourceAcquisitionStep(input: {
  db: ProviderSourceImportDb;
  snapshot: Snapshot;
  userId: string;
  step: { id: string; attempt: number };
  contract: AgentStepContractV1;
  grant: AgentStepCapabilityGrantV2;
  now?: () => string;
  shouldContinue?: () => Promise<boolean>;
  dependencies?: {
    executeAcquisition?: typeof executeCurrentUserProviderSourceAcquisition;
    recordProgress?: (
      state: ReturnType<typeof providerSourceAcquisitionStateSchema.parse>,
    ) => Promise<boolean>;
  };
}): Promise<AgentSourceAcquisitionExecutionOutcomeV1> {
  if (
    input.contract.operation !== "source.acquire" ||
    input.grant.operation !== "source.acquire" ||
    input.grant.step_position !== input.contract.position ||
    input.grant.read_only_connector_pins.length !== 1
  ) {
    throw new Error("Source acquisition requires one fixed connector grant");
  }
  let state = readState(input.snapshot);
  const pin = input.grant.read_only_connector_pins[0];
  if (state.spec.connector_id !== pin.connector_id) {
    throw new Error(
      "Source acquisition state does not match its connector grant",
    );
  }
  const fixedContext = readFixedMatterContext(input.snapshot.task);
  if (!fixedContext) {
    throw new Error("Source acquisition requires one fixed Matter context");
  }
  const context = {
    taskId: input.snapshot.task.id,
    stepId: input.step.id,
    stepPosition: input.contract.position,
    attempt: input.step.attempt,
    matterId: input.snapshot.task.matter_id,
    sourceVersionIds: fixedContext.sources.map((source) => source.version_id),
  };
  const executeAcquisition =
    input.dependencies?.executeAcquisition ??
    executeCurrentUserProviderSourceAcquisition;
  const assertCanContinue = async () => {
    if (input.shouldContinue && !(await input.shouldContinue())) {
      throw new AgentTaskExecutionInterruptedError();
    }
  };
  const recordProgress = async () => {
    if (
      input.dependencies?.recordProgress &&
      !(await input.dependencies.recordProgress(state))
    ) {
      throw new AgentTaskExecutionInterruptedError();
    }
  };

  while (state.phase === "search_pending") {
    await assertCanContinue();
    const page = state.next_page;
    if (page === null) throw new Error("Pending source search has no page");
    const request = compileProviderSourceSearchRequest({
      spec: state.spec,
      pin,
      requestRef: requestRef({
        stepId: input.step.id,
        attempt: input.step.attempt,
        operation: "search",
        sequence: page,
      }),
      page,
    });
    const outcome = await executeAcquisition({
      db: input.db,
      userId: input.userId,
      matterId: input.snapshot.task.matter_id,
      connectorId: pin.connector_id,
      operation: "search",
      context,
      grant: input.grant,
      request,
      now: input.now,
    });
    if (outcome.kind === "provider_pause") {
      return {
        kind: "provider_pause",
        classification: outcome.classification,
        checkpointValues: { source_acquisition: state },
      };
    }
    if (outcome.kind === "rejected") {
      throw new Error(`Source acquisition rejected: ${outcome.code}`);
    }
    state = appendProviderSourceSearchPage({
      state,
      pin,
      request,
      outcome,
    });
    await recordProgress();
  }

  while (state.phase === "read_pending") {
    await assertCanContinue();
    const sequence = state.import_receipts.length + 1;
    const request = compileNextProviderSourceSelectedRead({
      state,
      pin,
      requestRef: requestRef({
        stepId: input.step.id,
        attempt: input.step.attempt,
        operation: "read",
        sequence,
      }),
    });
    const outcome = await executeAcquisition({
      db: input.db,
      userId: input.userId,
      matterId: input.snapshot.task.matter_id,
      connectorId: pin.connector_id,
      operation: "read_snapshot",
      context,
      grant: input.grant,
      request,
      now: input.now,
    });
    if (outcome.kind === "provider_pause") {
      return {
        kind: "provider_pause",
        classification: outcome.classification,
        checkpointValues: { source_acquisition: state },
      };
    }
    if (outcome.kind === "rejected") {
      throw new Error(`Selected source read rejected: ${outcome.code}`);
    }
    state = recordProviderSourceSelectedRead({ state, pin, request, outcome });
    await recordProgress();
  }

  return { kind: "execution", result: executionResult(state) };
}
