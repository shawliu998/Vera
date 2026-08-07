import { randomUUID } from "node:crypto";
import { clearInterval, setInterval } from "node:timers";

import type { createServerSupabase } from "../../supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const DEFAULT_TASK_LEASE_TTL_SECONDS = 240;
export const DEFAULT_TASK_LEASE_HEARTBEAT_SECONDS = 30;
export const DEFAULT_TASK_LEASE_BUSY_WAIT_MS = 500;

type LeaseState = { acquired: boolean; expires_at: string | null };
type RenewState = { renewed: boolean; expires_at: string | null };

export type AgentTaskLeaseRpc = {
  acquire(input: {
    p_task_id: string;
    p_user_id: string;
    p_owner_token: string;
    p_ttl_seconds: number;
  }): Promise<LeaseState>;
  renew(input: {
    p_task_id: string;
    p_user_id: string;
    p_owner_token: string;
    p_ttl_seconds: number;
  }): Promise<RenewState>;
  release(input: {
    p_task_id: string;
    p_user_id: string;
    p_owner_token: string;
  }): Promise<{ released: boolean }>;
};

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

export function createAgentTaskLeaseRpc(db: Db): AgentTaskLeaseRpc {
  return {
    async acquire(input) {
      const { data, error } = await db.rpc(
        "acquire_agent_task_execution_lease_v1",
        input,
      );
      if (error) throw new Error(error.message);
      const row = firstRow(data) as Record<string, unknown> | null;
      return {
        acquired: Boolean(row?.acquired),
        expires_at: typeof row?.expires_at === "string" ? row.expires_at : null,
      };
    },
    async renew(input) {
      const { data, error } = await db.rpc(
        "renew_agent_task_execution_lease_v1",
        input,
      );
      if (error) throw new Error(error.message);
      const row = firstRow(data) as Record<string, unknown> | null;
      return {
        renewed: Boolean(row?.renewed),
        expires_at: typeof row?.expires_at === "string" ? row.expires_at : null,
      };
    },
    async release(input) {
      const { data, error } = await db.rpc(
        "release_agent_task_execution_lease_v1",
        input,
      );
      if (error) throw new Error(error.message);
      const row = firstRow(data) as Record<string, unknown> | null;
      return { released: Boolean(row?.released) };
    },
  };
}

export class AgentTaskLeaseBusyError extends Error {
  constructor() {
    super("Agent Task execution is already owned by another runner");
    this.name = "AgentTaskLeaseBusyError";
  }
}

export function isAgentTaskLeaseBusyError(error: unknown) {
  return (
    error instanceof AgentTaskLeaseBusyError ||
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AgentTaskLeaseBusyError",
    )
  );
}

export type AgentTaskLeaseGuard = {
  ownerToken: string;
  verifyOwner: () => Promise<boolean>;
};

export type AgentTaskLeaseOptions = {
  rpc?: AgentTaskLeaseRpc;
  ownerToken?: string;
  ttlSeconds?: number;
  heartbeatSeconds?: number;
  busyWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export async function withAgentTaskLease<T>(
  input: {
    db: Db;
    taskId: string;
    userId: string;
    getSnapshot: () => Promise<unknown>;
  },
  options: AgentTaskLeaseOptions,
  callback: (guard: AgentTaskLeaseGuard) => Promise<T>,
): Promise<
  | { status: "acquired"; result: T }
  | { status: "unavailable"; reason: "busy" | "lost"; snapshot: unknown }
> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TASK_LEASE_TTL_SECONDS;
  const heartbeatSeconds =
    options.heartbeatSeconds ?? DEFAULT_TASK_LEASE_HEARTBEAT_SECONDS;
  if (
    ttlSeconds < 30 ||
    ttlSeconds > 3600 ||
    heartbeatSeconds < 1 ||
    heartbeatSeconds >= ttlSeconds
  ) {
    throw new Error("Agent Task lease timing is invalid");
  }
  const rpc = options.rpc ?? createAgentTaskLeaseRpc(input.db);
  const ownerToken = options.ownerToken ?? randomUUID();
  const acquired = await rpc.acquire({
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_owner_token: ownerToken,
    p_ttl_seconds: ttlSeconds,
  });
  if (!acquired.acquired) {
    const wait = Math.max(
      0,
      Math.min(options.busyWaitMs ?? DEFAULT_TASK_LEASE_BUSY_WAIT_MS, 5000),
    );
    await (
      options.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
    )(wait);
    return {
      status: "unavailable",
      reason: "busy",
      snapshot: await input.getSnapshot(),
    };
  }

  let lost = false;
  let stopped = false;
  let renewal: Promise<boolean> | null = null;
  const renew = () => {
    if (lost) return Promise.resolve(false);
    if (renewal) return renewal;
    const pending = rpc
      .renew({
        p_task_id: input.taskId,
        p_user_id: input.userId,
        p_owner_token: ownerToken,
        p_ttl_seconds: ttlSeconds,
      })
      .then((result) => {
        if (!result.renewed) lost = true;
        return !lost;
      })
      .catch(() => {
        lost = true;
        return false;
      })
      .finally(() => {
        if (renewal === pending) renewal = null;
      });
    renewal = pending;
    return pending;
  };
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? clearInterval;
  const timer = schedule(() => {
    if (!stopped) void renew();
  }, heartbeatSeconds * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();

  let result: T | undefined;
  let callbackError: unknown;
  try {
    result = await callback({ ownerToken, verifyOwner: renew });
    await renew();
  } catch (error) {
    callbackError = error;
  } finally {
    stopped = true;
    unschedule(timer);
    if (renewal) await renewal;
    try {
      await rpc.release({
        p_task_id: input.taskId,
        p_user_id: input.userId,
        p_owner_token: ownerToken,
      });
    } catch {
      // The expiring owner-token fence makes release best-effort cleanup.
    }
  }
  if (lost) {
    return {
      status: "unavailable",
      reason: "lost",
      snapshot: await input.getSnapshot(),
    };
  }
  if (callbackError !== undefined) throw callbackError;
  return { status: "acquired", result: result as T };
}
