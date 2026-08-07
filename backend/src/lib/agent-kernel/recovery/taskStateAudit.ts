import { readAgentStepEffectReceipts } from "../effects/stepEffect";

export type AgentTaskStateAuditTask = {
  id: string;
  status: string;
  current_step: string | null;
  latest_checkpoint?: unknown;
  execution_lease_owner?: string | null;
  execution_lease_expires_at?: string | null;
};

export type AgentTaskStateAuditStep = {
  id: string;
  task_id: string;
  position: number;
  status: string;
  attempt: number;
  result_data?: unknown;
};

export type AgentTaskStateAuditIssue = {
  code: string;
  task_id: string;
  disposition: "mechanically_repairable" | "observation" | "review_required";
  facts: Record<string, unknown>;
};

function issue(
  code: string,
  taskId: string,
  disposition: AgentTaskStateAuditIssue["disposition"],
  facts: Record<string, unknown> = {},
): AgentTaskStateAuditIssue {
  return { code, task_id: taskId, disposition, facts };
}

export function auditAgentTaskState(
  tasks: AgentTaskStateAuditTask[],
  steps: AgentTaskStateAuditStep[],
  nowMs = Date.now(),
) {
  const issues: AgentTaskStateAuditIssue[] = [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const stepsByTask = new Map<string, AgentTaskStateAuditStep[]>();
  for (const step of steps) {
    const taskSteps = stepsByTask.get(step.task_id) ?? [];
    taskSteps.push(step);
    stepsByTask.set(step.task_id, taskSteps);
    if (!taskIds.has(step.task_id)) {
      issues.push(
        issue("orphan_step", step.task_id, "review_required", {
          step_id: step.id,
        }),
      );
    }
  }
  for (const taskSteps of stepsByTask.values()) {
    taskSteps.sort((left, right) => left.position - right.position);
  }

  for (const task of tasks) {
    const plan = stepsByTask.get(task.id) ?? [];
    const running = plan.filter((step) => step.status === "running");
    const blocked = plan.filter((step) => step.status === "blocked");
    const current = task.current_step
      ? (plan.find((step) => step.id === task.current_step) ?? null)
      : null;
    const currentIndex = current ? plan.indexOf(current) : -1;
    const invalidBefore =
      currentIndex < 0
        ? []
        : plan
            .slice(0, currentIndex)
            .filter((step) => !["completed", "skipped"].includes(step.status));
    const invalidAfter =
      currentIndex < 0
        ? []
        : plan
            .slice(currentIndex + 1)
            .filter((step) => step.status !== "pending");

    const leaseOwner = task.execution_lease_owner ?? null;
    const leaseExpiry = task.execution_lease_expires_at ?? null;
    if ((leaseOwner === null) !== (leaseExpiry === null)) {
      issues.push(issue("lease_pair_mismatch", task.id, "review_required", {}));
    }
    if (
      !["queued", "running", "verifying"].includes(task.status) &&
      leaseOwner !== null
    ) {
      const expiryMs = Date.parse(leaseExpiry ?? "");
      const expired = Number.isFinite(expiryMs) && expiryMs <= nowMs;
      issues.push(
        issue(
          expired ? "inactive_task_expired_lease" : "inactive_task_live_lease",
          task.id,
          expired ? "mechanically_repairable" : "observation",
          { lease_expired: expired },
        ),
      );
    }
    if (
      task.latest_checkpoint !== null &&
      task.latest_checkpoint !== undefined &&
      (typeof task.latest_checkpoint !== "object" ||
        Array.isArray(task.latest_checkpoint))
    ) {
      issues.push(
        issue("checkpoint_malformed", task.id, "review_required", {}),
      );
    }
    if (task.current_step && !current) {
      issues.push(
        issue("current_step_missing", task.id, "review_required", {
          current_step: task.current_step,
        }),
      );
    }
    if (running.length > 1) {
      issues.push(
        issue("multiple_running_steps", task.id, "review_required", {
          count: running.length,
        }),
      );
    }
    if (blocked.length > 1) {
      issues.push(
        issue("multiple_blocked_steps", task.id, "review_required", {
          count: blocked.length,
        }),
      );
    }

    if (["running", "verifying"].includes(task.status)) {
      if (!current || current.status !== "running" || running.length !== 1) {
        issues.push(
          issue("active_shape_invalid", task.id, "review_required", {}),
        );
      } else {
        if (blocked.length > 0 || invalidBefore.length > 0) {
          issues.push(
            issue("active_predecessor_invalid", task.id, "review_required", {
              count: blocked.length + invalidBefore.length,
            }),
          );
        }
        if (invalidAfter.length > 0) {
          issues.push(
            issue("active_successor_invalid", task.id, "review_required", {
              count: invalidAfter.length,
            }),
          );
        }
        const pendingAfter = plan
          .slice(currentIndex + 1)
          .some((step) => step.status === "pending");
        const derived = pendingAfter ? "running" : "verifying";
        if (task.status !== derived) {
          issues.push(
            issue("active_phase_mismatch", task.id, "review_required", {
              persisted: task.status,
              derived,
            }),
          );
        }
      }
    } else if (task.status === "queued") {
      if (
        task.current_step !== null ||
        running.length > 0 ||
        blocked.length > 0 ||
        plan.some((step) => step.status !== "pending")
      ) {
        issues.push(
          issue("queued_shape_invalid", task.id, "review_required", {}),
        );
      }
    } else if (task.status === "paused") {
      const plannerShape =
        task.current_step === null &&
        running.length === 0 &&
        blocked.length === 0 &&
        plan.every((step) => step.status === "pending");
      const activeShape = Boolean(
        current &&
        current.status === "running" &&
        running.length === 1 &&
        blocked.length === 0 &&
        invalidBefore.length === 0 &&
        invalidAfter.length === 0,
      );
      if (!plannerShape && !activeShape) {
        issues.push(
          issue("paused_shape_invalid", task.id, "review_required", {}),
        );
      }
    } else if (task.status === "waiting_input") {
      if (
        !current ||
        current.status !== "blocked" ||
        blocked.length !== 1 ||
        running.length > 0
      ) {
        issues.push(
          issue("waiting_input_shape_invalid", task.id, "review_required", {}),
        );
      }
    } else if (task.status === "failed") {
      const plannerFailure =
        task.current_step === null &&
        running.length === 0 &&
        blocked.length === 0;
      const stepFailure = Boolean(
        current &&
        current.status === "blocked" &&
        blocked.length === 1 &&
        running.length === 0,
      );
      if (!plannerFailure && !stepFailure) {
        issues.push(
          issue("failed_shape_invalid", task.id, "review_required", {}),
        );
      }
    } else if (task.status === "completed") {
      const allSettled = plan.every((step) =>
        ["completed", "skipped"].includes(step.status),
      );
      if (
        task.current_step !== null &&
        current &&
        ["completed", "skipped"].includes(current.status) &&
        running.length === 0 &&
        blocked.length === 0 &&
        allSettled
      ) {
        issues.push(
          issue(
            "completed_current_step_stale",
            task.id,
            "mechanically_repairable",
            { current_step: task.current_step },
          ),
        );
      } else if (
        task.current_step !== null ||
        running.length > 0 ||
        blocked.length > 0 ||
        !allSettled
      ) {
        issues.push(
          issue("completed_shape_invalid", task.id, "review_required", {}),
        );
      }
    } else {
      issues.push(
        issue("unknown_task_status", task.id, "review_required", {
          status: task.status,
        }),
      );
    }

    for (const step of plan) {
      try {
        for (const receipt of readAgentStepEffectReceipts(step.result_data)) {
          if (receipt.step_id !== step.id || receipt.attempt > step.attempt) {
            issues.push(
              issue(
                "effect_receipt_identity_invalid",
                task.id,
                "review_required",
                {
                  step_id: step.id,
                  receipt_attempt: receipt.attempt,
                  step_attempt: step.attempt,
                },
              ),
            );
          }
        }
      } catch {
        issues.push(
          issue("effect_receipt_malformed", task.id, "review_required", {
            step_id: step.id,
          }),
        );
      }
    }
  }

  const byCode: Record<string, number> = {};
  const byDisposition: Record<string, number> = {};
  for (const found of issues) {
    byCode[found.code] = (byCode[found.code] ?? 0) + 1;
    byDisposition[found.disposition] =
      (byDisposition[found.disposition] ?? 0) + 1;
  }
  return {
    schema_version: 1 as const,
    counts: { tasks: tasks.length, steps: steps.length, issues: issues.length },
    issue_counts: byCode,
    disposition_counts: byDisposition,
    affected_task_ids: [...new Set(issues.map((found) => found.task_id))],
    issues,
  };
}
