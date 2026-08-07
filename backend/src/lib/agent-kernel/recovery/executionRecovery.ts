import { readAgentStepCapabilityGrants } from "../capability/stepCapability";
import { readAgentTaskAssignmentContract } from "../contracts/taskContract";
import { readAgentStepContracts } from "../contracts/stepContract";

export type AgentTaskExecutionRecovery =
  | { allowed: true; issue_code: null; detail: null }
  | {
      allowed: false;
      issue_code:
        | "assignment_contract_invalid"
        | "step_contract_invalid"
        | "capability_grant_invalid";
      detail: string;
    };

const RESTART_DETAIL =
  "This task was created with an incomplete or invalid execution contract. Existing work is preserved, but this task cannot continue safely. Start a new Work Task from the same Matter and sources.";

export function evaluateAgentTaskExecutionRecovery(task: {
  goal?: unknown;
  matter_id?: unknown;
  deliverables?: unknown;
  latest_checkpoint?: unknown;
  current_plan?: unknown[];
}): AgentTaskExecutionRecovery {
  const assignment = readAgentTaskAssignmentContract(task);
  if (assignment.state === "invalid") {
    return {
      allowed: false,
      issue_code: "assignment_contract_invalid",
      detail: RESTART_DETAIL,
    };
  }

  const stepContracts = readAgentStepContracts(task);
  if (stepContracts.state === "invalid") {
    return {
      allowed: false,
      issue_code: "step_contract_invalid",
      detail: RESTART_DETAIL,
    };
  }

  const grants = readAgentStepCapabilityGrants(task);
  if (grants.state === "invalid") {
    return {
      allowed: false,
      issue_code: "capability_grant_invalid",
      detail: RESTART_DETAIL,
    };
  }

  return { allowed: true, issue_code: null, detail: null };
}

export function assertAgentTaskExecutionRecovery(
  task: Parameters<typeof evaluateAgentTaskExecutionRecovery>[0],
) {
  const recovery = evaluateAgentTaskExecutionRecovery(task);
  if (!recovery.allowed) {
    throw new Error(
      `This task cannot continue safely (${recovery.issue_code}). ${recovery.detail}`,
    );
  }
  return recovery;
}
