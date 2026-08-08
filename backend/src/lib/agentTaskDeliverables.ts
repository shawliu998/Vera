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

export function isTabularReviewArtifact(
  artifact: Pick<AgentArtifactLinkInput, "artifact_type"> | null | undefined,
) {
  return artifact?.artifact_type === "tabular_review";
}

export async function evaluateTaskDeliverables(
  db: Db,
  snapshot: {
    task: { matter_id?: string; deliverables?: unknown };
    artifacts: AgentArtifactLinkInput[];
  },
  options: { userId?: string } = {},
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
  const documentIds = resolved.flatMap((item) =>
    item.artifact &&
    !isTabularReviewArtifact(item.artifact) &&
    ["draft", "document"].includes(item.artifact.artifact_type)
      ? [item.artifact.artifact_id]
      : [],
  );
  const reviewIds = resolved.flatMap((item) =>
    item.artifact && isTabularReviewArtifact(item.artifact)
      ? [item.artifact.artifact_id]
      : [],
  );
  const { data: documents, error } = documentIds.length
    ? await db.from("documents").select("id,project_id").in("id", documentIds)
    : { data: [], error: null };
  if (error) throw new Error(error.message);
  const { data: reviews, error: reviewError } = reviewIds.length
    ? await db
        .from("tabular_reviews")
        .select("id,project_id,user_id,row_protocol")
        .in("id", reviewIds)
    : { data: [], error: null };
  if (reviewError) throw new Error(reviewError.message);
  const matterByDocument = new Map(
    (documents ?? []).map((document) => [
      document.id as string,
      document.project_id as string | null,
    ]),
  );
  const reviewById = new Map(
    (reviews ?? []).map((review) => [review.id as string, review]),
  );
  const outsideMatter = resolved.flatMap((item) => {
    if (!item.artifact) return [];
    if (isTabularReviewArtifact(item.artifact)) {
      const review = reviewById.get(item.artifact.artifact_id);
      return review?.project_id === snapshot.task.matter_id &&
        review?.row_protocol === "document_rows" &&
        (!options.userId || review?.user_id === options.userId)
        ? []
        : [item.deliverable.title || taskDeliverablePurpose(item.deliverable)];
    }
    return matterByDocument.get(item.artifact.artifact_id) ===
      snapshot.task.matter_id
      ? []
      : [item.deliverable.title || taskDeliverablePurpose(item.deliverable)];
  });
  return { required, resolved, missing, outsideMatter };
}
