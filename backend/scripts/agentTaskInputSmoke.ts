import assert from "node:assert/strict";
import {
  agentTaskInputDocumentsMatch,
  prepareAgentTaskInputTransition,
  readAgentTaskSupplementalInput,
  reserveAgentTaskInputStep,
} from "../src/lib/agentTasks";

const submittedAt = "2026-07-21T08:00:00.000Z";

function waitingSnapshot(options?: {
  status?: "waiting_input" | "running";
  blockedPosition?: number;
  attempt?: number;
}) {
  const blockedPosition = options?.blockedPosition ?? 1;
  return {
    task: {
      status: options?.status ?? ("waiting_input" as const),
      latest_checkpoint: {
        step_id: `step_${blockedPosition}`,
        iteration: options?.attempt ?? 1,
        summary: "Please confirm the governing law and client position.",
        created_at: "2026-07-21T07:59:00.000Z",
      },
      current_plan: [0, 1, 2].map((position) => ({
        id: `step_${position}`,
        status:
          position < blockedPosition
            ? ("completed" as const)
            : position === blockedPosition
              ? ("blocked" as const)
              : ("pending" as const),
        attempt: position === blockedPosition ? (options?.attempt ?? 1) : 0,
      })),
    },
  };
}

function fakeReservationDb() {
  const row = {
    id: "step_1",
    task_id: "task_1",
    status: "blocked",
    attempt: 1,
  };
  return {
    from() {
      const filters: Record<string, unknown> = {};
      let update: Record<string, unknown> = {};
      const builder = {
        update(value: Record<string, unknown>) {
          update = value;
          return builder;
        },
        eq(key: string, value: unknown) {
          filters[key] = value;
          return builder;
        },
        select() {
          return builder;
        },
        async maybeSingle() {
          const matches = Object.entries(filters).every(
            ([key, value]) => row[key as keyof typeof row] === value,
          );
          if (!matches) return { data: null, error: null };
          Object.assign(row, update);
          return { data: { id: row.id }, error: null };
        },
      };
      return builder;
    },
  };
}

async function main() {
  const textOnly = prepareAgentTaskInputTransition(
    waitingSnapshot(),
    { message: "  适用新加坡法；立场为客户方。  " },
    submittedAt,
  );
  assert.equal(textOnly.status, "running");
  assert.equal(textOnly.nextAttempt, 2);
  assert.deepEqual(textOnly.documentIds, []);
  assert.equal(
    readAgentTaskSupplementalInput({
      latest_checkpoint: textOnly.checkpoint,
    })?.message,
    "适用新加坡法；立场为客户方。",
    "a refreshed or restarted executor must recover the response",
  );

  const documentsOnly = prepareAgentTaskInputTransition(
    waitingSnapshot(),
    { documentIds: ["doc_1", "doc_1", " doc_2 "] },
    submittedAt,
  );
  assert.deepEqual(documentsOnly.documentIds, ["doc_1", "doc_2"]);
  assert.equal(
    readAgentTaskSupplementalInput({
      latest_checkpoint: documentsOnly.checkpoint,
    })?.message,
    undefined,
  );

  const textAndDocuments = prepareAgentTaskInputTransition(
    waitingSnapshot(),
    { message: "Use a concise business tone.", documentIds: ["doc_3"] },
    submittedAt,
  );
  assert.equal(
    readAgentTaskSupplementalInput({
      latest_checkpoint: textAndDocuments.checkpoint,
    })?.document_ids[0],
    "doc_3",
  );

  assert.throws(
    () => prepareAgentTaskInputTransition(waitingSnapshot(), {}),
    /message or Matter document/i,
  );
  assert.throws(
    () =>
      prepareAgentTaskInputTransition(waitingSnapshot({ status: "running" }), {
        message: "Duplicate response",
      }),
    /Only a task waiting for input/,
  );
  assert.throws(
    () =>
      prepareAgentTaskInputTransition(waitingSnapshot(), {
        message: "x".repeat(4001),
      }),
    /too long/,
  );

  const verifierInput = prepareAgentTaskInputTransition(
    waitingSnapshot({ blockedPosition: 2, attempt: 3 }),
    { message: "Confirm the final source limitation." },
    submittedAt,
  );
  assert.equal(verifierInput.status, "verifying");
  assert.equal(verifierInput.nextAttempt, 4);

  assert.equal(
    agentTaskInputDocumentsMatch(
      ["doc_1", "doc_2"],
      [{ id: "doc_2" }, { id: "doc_1" }],
    ),
    true,
  );
  assert.equal(
    agentTaskInputDocumentsMatch(
      ["doc_1", "doc_other_matter"],
      [{ id: "doc_1" }],
    ),
    false,
    "a document outside the task Matter must be rejected",
  );

  const reservationDb = fakeReservationDb();
  const reservation = {
    taskId: "task_1",
    stepId: "step_1",
    currentAttempt: 1,
    nextAttempt: 2,
    updatedAt: submittedAt,
  };
  assert.equal(
    await reserveAgentTaskInputStep(reservationDb as never, reservation),
    true,
  );
  assert.equal(
    await reserveAgentTaskInputStep(reservationDb as never, reservation),
    false,
    "the conditional blocked-step reservation must reject a double submit",
  );

  console.log(
    JSON.stringify({ ok: true, suite: "agent-task-input-smoke-v1" }, null, 2),
  );
}

void main();
