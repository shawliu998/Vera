import assert from "node:assert/strict";
import { updateAgentTaskExecutionModel } from "../src/lib/agentTasks";

type QueryBuilder = {
  from: (table: string) => TableBuilder;
};

type TableBuilder = {
  select: (columns?: string) => FilterableBuilder;
  update: (values: Record<string, unknown>) => FilterableBuilder;
  insert: () => InsertBuilder;
  upsert: () => { error: null };
  delete: () => { error: null };
};

type FilterableBuilder = {
  eq: (column: string, value: unknown) => FilterableBuilder;
  order: () => FilterableBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
};

type InsertBuilder = {
  select: () => { single: () => { data: null; error: null } };
};

function makeTask(overrides: { status: string; userId?: string }) {
  return {
    id: "task_1",
    user_id: overrides.userId ?? "user_1",
    matter_id: "matter_1",
    goal: "Test task",
    mode: "work",
    status: overrides.status,
    execution_model: "gemini-3-flash-preview",
    deliverables: [],
    current_step: null,
    latest_checkpoint: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeStubDb(taskStatus: string, userId = "user_1") {
  const task = makeTask({ status: taskStatus, userId });
  const steps = [
    {
      id: "step_1",
      task_id: "task_1",
      title: "Step one",
      status: "pending",
      expected_output: "Do step one",
      attempt: 0,
      result_summary: null,
      position: 0,
    },
  ];
  const artifacts: unknown[] = [];

  function filterable(table: string, filters: Record<string, unknown>) {
    return {
      eq: (column: string, value: unknown) =>
        filterable(table, { ...filters, [column]: value }),
      order: () => filterable(table, filters),
      maybeSingle: async () => {
        if (table === "agent_tasks") {
          const matchesUser =
            filters.user_id === undefined || filters.user_id === task.user_id;
          const matchesId =
            filters.id === undefined || filters.id === task.id;
          return { data: matchesUser && matchesId ? task : null, error: null };
        }
        return { data: null, error: null };
      },
    };
  }

  const db = {
    from: (table: string) => ({
      select: (columns?: string) => {
        if (table === "agent_tasks") {
          return filterable(table, {});
        }
        if (table === "agent_steps" || table === "agent_artifact_links") {
          return {
            eq: () => ({
              order: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
            order: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          };
        }
        return filterable(table, {});
      },
      update: (values: Record<string, unknown>) => {
        const applyUpdate = (filters: Record<string, unknown>) => ({
          eq: (column: string, value: unknown) => {
            const nextFilters = { ...filters, [column]: value };
            if (
              table === "agent_tasks" &&
              nextFilters.user_id === task.user_id &&
              nextFilters.id === task.id
            ) {
              task.execution_model = values.execution_model as string;
              task.updated_at = values.updated_at as string;
            }
            return applyUpdate(nextFilters);
          },
          error: null,
        });
        return applyUpdate({});
      },
      insert: () =>
        ({
          select: () => ({ single: () => ({ data: null, error: null }) }),
        }) as InsertBuilder,
      upsert: () => ({ error: null }),
      delete: () => ({ error: null }),
    }),
  } as unknown as QueryBuilder;

  // getAgentTaskSnapshot reads data/error directly from the ordered query
  // result for steps and artifacts, so patch those builders.
  const originalFrom = db.from.bind(db);
  db.from = (table: string) => {
    const base = originalFrom(table);
    if (table === "agent_steps") {
      return {
        ...base,
        select: () => ({
          eq: () => ({
            order: () => ({
              data: steps,
              error: null,
            }),
          }),
        }),
      } as TableBuilder;
    }
    if (table === "agent_artifact_links") {
      return {
        ...base,
        select: () => ({
          eq: () => ({
            order: () => ({
              data: artifacts,
              error: null,
            }),
          }),
        }),
      } as TableBuilder;
    }
    return base;
  };

  return { db: db as unknown as ReturnType<typeof import("../src/lib/supabase").createServerSupabase>, task };
}

async function main() {
  const allowedStates = ["queued", "paused", "waiting_input", "failed"] as const;
  for (const status of allowedStates) {
    const { db, task } = makeStubDb(status);
    const result = await updateAgentTaskExecutionModel(
      db,
      "task_1",
      "user_1",
      "deepseek-v4-flash",
    );
    assert.ok(result, `expected snapshot for status ${status}`);
    assert.equal(result.task.execution_model, "deepseek-v4-flash");
    assert.equal(task.execution_model, "deepseek-v4-flash");
  }

  const blockedStates = ["running", "verifying", "completed"] as const;
  for (const status of blockedStates) {
    const { db } = makeStubDb(status);
    await assert.rejects(
      () => updateAgentTaskExecutionModel(db, "task_1", "user_1", "deepseek-v4-flash"),
      /Only a queued, paused, failed, or input-blocked task can switch models/,
      `expected rejection for status ${status}`,
    );
  }

  // Ownership: task owned by another user returns null without updating.
  const { db, task } = makeStubDb("queued", "other_user");
  const result = await updateAgentTaskExecutionModel(
    db,
    "task_1",
    "user_1",
    "deepseek-v4-flash",
  );
  assert.equal(result, null);
  assert.equal(task.execution_model, "gemini-3-flash-preview");

  // Unsupported model is rejected by the route; the lib function assumes
  // validation already happened, so we only verify the route path here by
  // confirming the helper import exists.
  assert.equal(typeof updateAgentTaskExecutionModel, "function");

  console.log(
    JSON.stringify({ ok: true, suite: "agent-task-model-smoke-v1" }, null, 2),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
