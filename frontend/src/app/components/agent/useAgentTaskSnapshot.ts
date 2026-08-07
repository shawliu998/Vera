import { useEffect, useRef, useState } from "react";

import { getAgentTask } from "@/app/lib/agentClient";
import type { AgentTaskSnapshot } from "@/app/types/agent";
import { createAgentTaskSnapshotGate } from "./agentTaskSnapshotGate";

interface AgentTaskSnapshotState {
  taskId: string;
  snapshot: AgentTaskSnapshot | null;
  loaded: boolean;
}

const POLL_INTERVAL_MS = 4_000;

export function useAgentTaskSnapshot(taskId: string) {
  const [state, setState] = useState<AgentTaskSnapshotState>({
    taskId,
    snapshot: null,
    loaded: false,
  });
  const gateRef = useRef(createAgentTaskSnapshotGate(taskId));
  const visibleState =
    state.taskId === taskId
      ? state
      : { taskId, snapshot: null, loaded: false };

  useEffect(() => {
    let cancelled = false;
    gateRef.current.reset(taskId);
    const token = gateRef.current.issue();
    void getAgentTask(taskId)
      .then((snapshot) => {
        if (!cancelled && gateRef.current.accept(token)) {
          setState({ taskId, snapshot, loaded: true });
        }
      })
      .catch(() => {
        if (!cancelled && gateRef.current.accept(token)) {
          setState({ taskId, snapshot: null, loaded: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const taskStatus = visibleState.snapshot?.task.status;
  useEffect(() => {
    if (
      !taskStatus ||
      !["queued", "running", "verifying"].includes(taskStatus)
    ) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    const poll = async () => {
      const token = gateRef.current.issue();
      try {
        const snapshot = await getAgentTask(taskId);
        if (!cancelled && gateRef.current.accept(token)) {
          setState({ taskId, snapshot, loaded: true });
        }
      } catch {
        // Preserve the last known snapshot during a transient poll failure.
      } finally {
        if (!cancelled) schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [taskId, taskStatus]);

  function commitSnapshot(snapshot: AgentTaskSnapshot) {
    if (snapshot.task.id !== taskId) return false;
    gateRef.current.commit();
    setState({ taskId, snapshot, loaded: true });
    return true;
  }

  return {
    snapshot: visibleState.snapshot,
    loaded: visibleState.loaded,
    commitSnapshot,
  };
}
