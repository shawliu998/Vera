export interface AgentTaskSnapshotRequestToken {
  taskId: string;
  sequence: number;
}

export function createAgentTaskSnapshotGate(initialTaskId: string) {
  let taskId = initialTaskId;
  let issued = 0;
  let applied = 0;

  return {
    reset(nextTaskId: string) {
      taskId = nextTaskId;
      issued = 0;
      applied = 0;
    },
    issue(): AgentTaskSnapshotRequestToken {
      issued += 1;
      return { taskId, sequence: issued };
    },
    isCurrent(token: AgentTaskSnapshotRequestToken): boolean {
      return token.taskId === taskId;
    },
    accept(token: AgentTaskSnapshotRequestToken): boolean {
      if (token.taskId !== taskId || token.sequence <= applied) return false;
      applied = token.sequence;
      return true;
    },
    commit(): AgentTaskSnapshotRequestToken {
      issued += 1;
      applied = issued;
      return { taskId, sequence: issued };
    },
  };
}
