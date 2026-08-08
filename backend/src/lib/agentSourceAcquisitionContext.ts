import {
  FIXED_MATTER_CONTEXT_CHECKPOINT_KEY,
  type MatterContextManifestV1,
} from "./agent-kernel/context/matterContext";
import { extendFixedMatterContext } from "./agent-kernel/context/matterContextRepository";
import { extendAgentTaskContractContext } from "./agent-kernel/contracts/taskContract";
import {
  providerSourceAcquisitionStateSchema,
  providerSourceSelectionCheckpointSchema,
} from "./providerSourceAcquisitionState";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

function readSourceSelection(checkpoint: unknown) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return null;
  }
  const selection = (checkpoint as Record<string, unknown>).source_selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return null;
  }
  const result = providerSourceSelectionCheckpointSchema.safeParse(selection);
  return result.success ? result.data : null;
}

export async function compileCompletedAgentSourceContext(input: {
  db: Db;
  previousCheckpoint: unknown;
  previousContext: MatterContextManifestV1;
  acquisitionState: unknown;
  dependencies?: {
    extendContext?: typeof extendFixedMatterContext;
  };
}) {
  const state = providerSourceAcquisitionStateSchema.parse(
    input.acquisitionState,
  );
  if (state.phase !== "completed") {
    throw new Error("Only completed source acquisition can extend Task scope");
  }
  const selection = readSourceSelection(input.previousCheckpoint);
  if (!selection) {
    throw new Error(
      "Completed source acquisition has no exact lawyer selection receipt",
    );
  }
  if (
    selection.selected_discovery_refs.length !==
      state.selected_discovery_refs.length ||
    selection.selected_discovery_refs.some(
      (ref, index) => ref !== state.selected_discovery_refs[index],
    )
  ) {
    throw new Error(
      "Completed source acquisition does not match the exact lawyer selection",
    );
  }
  const sourceDocumentIds = state.import_receipts.map(
    (receipt) => receipt.document_id,
  );
  if (
    sourceDocumentIds.length === 0 ||
    new Set(sourceDocumentIds).size !== sourceDocumentIds.length
  ) {
    throw new Error(
      "Completed source acquisition must bind unique imported Documents",
    );
  }
  const previousCheckpoint =
    input.previousCheckpoint &&
    typeof input.previousCheckpoint === "object" &&
    !Array.isArray(input.previousCheckpoint)
      ? {
          ...(input.previousCheckpoint as Record<string, unknown>),
          source_acquisition: state,
        }
      : null;
  if (!previousCheckpoint) {
    throw new Error("Completed source acquisition checkpoint is missing");
  }
  const extendedContext = await (
    input.dependencies?.extendContext ?? extendFixedMatterContext
  )(input.db, input.previousContext, sourceDocumentIds);
  const revisedCheckpoint = extendAgentTaskContractContext({
    checkpoint: previousCheckpoint,
    previousContext: input.previousContext,
    nextContext: extendedContext,
    reason: "source_acquisition",
    requestId: selection.submission_id,
  });
  return {
    sourceDocumentIds,
    checkpointValues: {
      ...revisedCheckpoint,
      [FIXED_MATTER_CONTEXT_CHECKPOINT_KEY]: extendedContext,
      source_acquisition: state,
    },
  };
}
