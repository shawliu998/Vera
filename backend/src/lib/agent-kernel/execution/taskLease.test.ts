import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { type AgentTaskLeaseRpc, withAgentTaskLease } from "./taskLease";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function fakeLeaseRpc(now: () => number = Date.now) {
  const leases = new Map<string, { owner: string; expires: number }>();
  const key = (task: string, user: string) => `${task}:${user}`;
  const rpc: AgentTaskLeaseRpc = {
    async acquire(input) {
      const id = key(input.p_task_id, input.p_user_id);
      const current = leases.get(id);
      if (
        current &&
        current.owner !== input.p_owner_token &&
        current.expires > now()
      ) {
        return { acquired: false, expires_at: null };
      }
      const expires = now() + input.p_ttl_seconds * 1000;
      leases.set(id, { owner: input.p_owner_token, expires });
      return { acquired: true, expires_at: new Date(expires).toISOString() };
    },
    async renew(input) {
      const id = key(input.p_task_id, input.p_user_id);
      const current = leases.get(id);
      if (
        !current ||
        current.owner !== input.p_owner_token ||
        current.expires <= now()
      ) {
        return { renewed: false, expires_at: null };
      }
      const expires = now() + input.p_ttl_seconds * 1000;
      leases.set(id, { owner: input.p_owner_token, expires });
      return { renewed: true, expires_at: new Date(expires).toISOString() };
    },
    async release(input) {
      const id = key(input.p_task_id, input.p_user_id);
      if (leases.get(id)?.owner !== input.p_owner_token) {
        return { released: false };
      }
      leases.delete(id);
      return { released: true };
    },
  };
  return { rpc, leases };
}

test("concurrent Task lease contenders execute exactly one callback", async () => {
  const { rpc } = fakeLeaseRpc();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const common = {
    db: {} as never,
    taskId: "task-1",
    userId: "user-1",
    getSnapshot: async () => ({ status: "running" }),
  };
  const first = withAgentTaskLease(
    common,
    { rpc, ownerToken: "owner-1" },
    async () => {
      calls.push("owner-1");
      await held;
      return "first";
    },
  );
  await Promise.resolve();
  const second = await withAgentTaskLease(
    common,
    { rpc, ownerToken: "owner-2", sleep: async () => undefined },
    async () => {
      calls.push("owner-2");
      return "second";
    },
  );
  assert.deepEqual(second, {
    status: "unavailable",
    reason: "busy",
    snapshot: { status: "running" },
  });
  release();
  assert.deepEqual(await first, { status: "acquired", result: "first" });
  assert.deepEqual(calls, ["owner-1"]);
});

test("an expired owner loses its result after takeover", async () => {
  let now = 0;
  const { rpc } = fakeLeaseRpc(() => now);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = withAgentTaskLease(
    {
      db: {} as never,
      taskId: "task-1",
      userId: "user-1",
      getSnapshot: async () => ({ owner: "owner-2" }),
    },
    {
      rpc,
      ownerToken: "owner-1",
      ttlSeconds: 30,
      heartbeatSeconds: 29,
    },
    async () => {
      await waiting;
      return "stale";
    },
  );
  await Promise.resolve();
  now = 31_000;
  assert.equal(
    (
      await rpc.acquire({
        p_task_id: "task-1",
        p_user_id: "user-1",
        p_owner_token: "owner-2",
        p_ttl_seconds: 30,
      })
    ).acquired,
    true,
  );
  finish();
  assert.deepEqual(await first, {
    status: "unavailable",
    reason: "lost",
    snapshot: { owner: "owner-2" },
  });
});

test("callback errors release the owner without replacing the error", async () => {
  const { rpc, leases } = fakeLeaseRpc();
  const failure = new Error("execution failed");
  await assert.rejects(
    withAgentTaskLease(
      {
        db: {} as never,
        taskId: "task-1",
        userId: "user-1",
        getSnapshot: async () => null,
      },
      { rpc, ownerToken: "owner-1" },
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(leases.size, 0);
});

test("backend and Supabase lease migrations are mirrored and service-only", () => {
  const backend = readFileSync(
    new URL(
      "backend/migrations/20260807_01_agent_execution_kernel.sql",
      repositoryRoot,
    ),
    "utf8",
  );
  const supabase = readFileSync(
    new URL(
      "supabase/migrations/20260807000001_agent_execution_kernel.sql",
      repositoryRoot,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /add column if not exists result_data jsonb/);
  assert.match(backend, /execution_lease_owner uuid/);
  assert.match(backend, /security definer/);
  assert.match(
    backend,
    /revoke execute[\s\S]*from public, anon, authenticated/,
  );
  assert.match(backend, /grant execute[\s\S]*to service_role/);
});
