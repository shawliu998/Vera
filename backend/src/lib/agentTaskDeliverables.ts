import type { AgentArtifactLinkInput } from "./agentTasks";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type TaskDeliverable = {
  key?: string;
  title?: string;
  description?: string;
  required?: boolean;
  artifact_type?: string;
  artifact_id?: string;
  purpose?: string;
};

const LEGACY_PURPOSES: Record<string, string> = {
  "risk-matrix": "Risk matrix",
  "review-memo": "Review memo draft",
};

export function taskDeliverablePurpose(deliverable: TaskDeliverable) {
  return (
    deliverable.purpose?.trim() ||
    (deliverable.key ? LEGACY_PURPOSES[deliverable.key] : "") ||
    deliverable.title?.trim() ||
    "Work product"
  );
}

export function requiredTaskDeliverables(task: { deliverables?: unknown }) {
  if (!Array.isArray(task.deliverables)) return [];
  return (task.deliverables as TaskDeliverable[]).filter(
    (deliverable) => deliverable.required !== false,
  );
}

export function findDeliverableArtifact(
  deliverable: TaskDeliverable,
  artifacts: AgentArtifactLinkInput[],
) {
  const expectedPurpose = taskDeliverablePurpose(deliverable);
  if (deliverable.artifact_id) {
    const exact = artifacts.find(
      (artifact) => artifact.artifact_id === deliverable.artifact_id,
    );
    if (exact) return exact;
  }
  return [...artifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.purpose === expectedPurpose &&
        (!deliverable.artifact_type ||
          artifact.artifact_type === deliverable.artifact_type),
    );
}

export async function evaluateTaskDeliverables(
  db: Db,
  snapshot: {
    task: { matter_id?: string; deliverables?: unknown };
    artifacts: AgentArtifactLinkInput[];
  },
) {
  const required = requiredTaskDeliverables(snapshot.task);
  const resolved = required.map((deliverable) => ({
    deliverable,
    artifact: findDeliverableArtifact(deliverable, snapshot.artifacts) ?? null,
  }));
  const missing = resolved
    .filter((item) => !item.artifact)
    .map(
      (item) =>
        item.deliverable.title || taskDeliverablePurpose(item.deliverable),
    );
  const generatedIds = resolved.flatMap((item) =>
    item.artifact &&
    ["draft", "tabular_review", "document"].includes(
      item.artifact.artifact_type,
    )
      ? [item.artifact.artifact_id]
      : [],
  );
  const { data: documents, error } = generatedIds.length
    ? await db.from("documents").select("id,project_id").in("id", generatedIds)
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  const matterByDocument = new Map(
    (documents ?? []).map((document) => [
      document.id as string,
      document.project_id as string | null,
    ]),
  );
  const outsideMatter = resolved.flatMap((item) => {
    if (!item.artifact) return [];
    return matterByDocument.get(item.artifact.artifact_id) ===
      snapshot.task.matter_id
      ? []
      : [item.deliverable.title || taskDeliverablePurpose(item.deliverable)];
  });
  return { required, resolved, missing, outsideMatter };
}
