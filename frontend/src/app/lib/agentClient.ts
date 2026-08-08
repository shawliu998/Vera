import { supabase } from "@/app/lib/supabase";
import type {
  AgentEvidenceSnapshot,
  AgentRequiredInputResponse,
  AgentTask,
  AgentTaskSnapshot,
} from "@/app/types/agent";
import {
  buildAgentTaskCreationBody,
  type AgentTaskCreationInput,
} from "@/app/lib/agentTaskCreationRequest";

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

export function createAgentTask(input: AgentTaskCreationInput) {
  return request<AgentTaskSnapshot>("/agent-tasks", {
    method: "POST",
    body: JSON.stringify(buildAgentTaskCreationBody(input)),
  });
}

export function submitAgentTaskSourceSelection(
  taskId: string,
  discoveryRefs: string[],
) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/source-selection`,
    {
      method: "POST",
      body: JSON.stringify({ discovery_refs: discoveryRefs }),
    },
  );
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

export function getAgentTaskEvidence(taskId: string, artifactId: string) {
  return request<AgentEvidenceSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(artifactId)}`,
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

export function reviseAgentTask(taskId: string) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/revise`,
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

export function submitAgentTaskInput(
  taskId: string,
  input: {
    message?: string;
    documentIds?: string[];
    responses?: AgentRequiredInputResponse[];
  },
) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/input`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(input.message?.trim() ? { message: input.message.trim() } : {}),
        document_ids: input.documentIds ?? [],
        ...(input.responses ? { responses: input.responses } : {}),
      }),
    },
  );
}

export function createAgentReviewDecision(
  taskId: string,
  input: { status: "approved" | "changes_requested"; note: string },
) {
  return request<AgentTaskSnapshot>(
    `/agent-tasks/${encodeURIComponent(taskId)}/review-decisions`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function downloadApprovedAgentArtifact(
  taskId: string,
  artifactId: string,
) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required");
  const response = await fetch(
    `${API_BASE}/agent-tasks/${encodeURIComponent(taskId)}/final-export/${encodeURIComponent(artifactId)}`,
    {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(
      payload?.detail || `Final export failed (${response.status})`,
    );
  }
  return response.blob();
}
