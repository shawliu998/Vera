import { supabase } from "@/app/lib/supabase";
import type { AgentTask, AgentTaskSnapshot } from "@/app/types/agent";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required");
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(
      payload?.detail || `Agent task request failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

export function createAgentTask(input: {
  goal: string;
  matterId: string;
  model: string;
  documentIds?: string[];
}) {
  return request<AgentTaskSnapshot>("/agent-tasks", {
    method: "POST",
    body: JSON.stringify({
      goal: input.goal,
      matter_id: input.matterId,
      model: input.model,
      document_ids: input.documentIds ?? [],
    }),
  });
}

export function listAgentTasks(matterId?: string) {
  const query = matterId ? `?matter_id=${encodeURIComponent(matterId)}` : "";
  return request<AgentTask[]>(`/agent-tasks${query}`);
}

export function getAgentTask(taskId: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}`,
  );
}

export function advanceAgentTask(taskId: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/advance`,
    {
      method: "POST",
    },
  );
}

export function pauseAgentTask(taskId: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/pause`,
    {
      method: "POST",
    },
  );
}

export function resumeAgentTask(taskId: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/resume`,
    {
      method: "POST",
    },
  );
}

export function retryAgentTask(taskId: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/retry`,
    {
      method: "POST",
    },
  );
}

export function updateAgentTaskModel(taskId: string, model: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/model`,
    {
      method: "PATCH",
      body: JSON.stringify({ model }),
    },
  );
}

export function attachAgentTaskDocuments(
  taskId: string,
  documentIds: string[],
) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/documents`,
    {
      method: "POST",
      body: JSON.stringify({ document_ids: documentIds }),
    },
  );
}
