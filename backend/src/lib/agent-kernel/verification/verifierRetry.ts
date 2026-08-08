import type { AgentTaskVerifierRetryTransitionOutcome } from "../execution/taskTransition";

export type AgentTaskVerifierRetryStarted = {
  outcome: "started" | "already_started";
  taskStatus: string | null;
  currentStep: string | null;
};

export class AgentTaskVerifierRetryError extends Error {
  constructor(
    readonly outcome: Exclude<
      AgentTaskVerifierRetryTransitionOutcome,
      "started" | "already_started"
    >,
    message: string,
  ) {
    super(message);
    this.name = "AgentTaskVerifierRetryError";
  }
}

export function requireAgentTaskVerifierRetryStarted(result: {
  outcome: AgentTaskVerifierRetryTransitionOutcome;
  taskStatus: string | null;
  currentStep: string | null;
}): AgentTaskVerifierRetryStarted {
  if (result.outcome === "started" || result.outcome === "already_started") {
    return result as AgentTaskVerifierRetryStarted;
  }
  throw new AgentTaskVerifierRetryError(
    result.outcome,
    result.outcome === "lease_busy"
      ? "Task execution is still closing. Re-run verification again in a moment."
      : result.outcome === "verification_result_invalid"
        ? "Re-verification requires one current structured review gap from the final Verifier."
        : result.outcome === "artifacts_invalid"
          ? "Re-verification requires current Task-owned deliverables."
          : result.outcome === "contract_invalid" ||
              result.outcome === "verifier_invalid"
            ? "This Task cannot safely restart only its final Verifier."
            : "Only one request can restart the final Verifier.",
  );
}
