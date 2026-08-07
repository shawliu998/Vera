import type { createServerSupabase } from "../../supabase";
import {
  commitAgentTaskArtifactReverificationTransition,
  type AgentTaskArtifactReverificationTransitionInput,
  type AgentTaskArtifactReverificationTransitionOutcome,
} from "../execution/taskTransition";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentTaskArtifactReverificationStarted = {
  outcome: "started" | "already_started";
  taskStatus: string | null;
  currentStep: string | null;
};

export class AgentTaskArtifactReverificationError extends Error {
  constructor(
    readonly outcome: Exclude<
      AgentTaskArtifactReverificationTransitionOutcome,
      "started" | "already_started"
    >,
    message: string,
  ) {
    super(message);
    this.name = "AgentTaskArtifactReverificationError";
  }
}

export async function startAgentTaskArtifactReverification(
  db: Db,
  input: AgentTaskArtifactReverificationTransitionInput,
): Promise<AgentTaskArtifactReverificationStarted> {
  const result = await commitAgentTaskArtifactReverificationTransition(
    db,
    input,
  );
  if (result.outcome === "started" || result.outcome === "already_started") {
    return result as AgentTaskArtifactReverificationStarted;
  }
  throw new AgentTaskArtifactReverificationError(
    result.outcome,
    result.outcome === "version_conflict"
      ? "The edited draft is no longer the current Artifact Version."
      : result.outcome === "artifact_not_found"
        ? "The edited document is no longer a declared draft for this Task."
        : result.outcome === "contract_invalid" ||
            result.outcome === "verifier_invalid"
          ? "The edited Version was preserved, but this Task cannot safely restart its Verifier."
          : "The edited Version was preserved, but Agent Task re-verification could not start.",
  );
}
