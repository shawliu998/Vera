import type { AgentArtifactLinkInput } from "./agentTasks";
import {
  findDeliverableArtifact,
  requiredTaskDeliverables,
  taskDeliverablePurpose,
} from "./agentTaskDeliverables";
import type { AgentReviewStatus } from "./agentTaskReviews";
import { createServerSupabase } from "./supabase";
import { readApprovedArtifactSnapshot } from "./agentApprovedArtifactSnapshot";

type Db = ReturnType<typeof createServerSupabase>;

type TaskSnapshot = {
  task: {
    id: string;
    matter_id: string;
    status: string;
    deliverables: Array<{
      key?: string;
      artifact_id?: string;
      title?: string;
      purpose?: string;
      required?: boolean;
      artifact_type?: string;
    }>;
  };
  artifacts: AgentArtifactLinkInput[];
  review?: {
    decisions?: Array<{
      id: string;
      status: AgentReviewStatus;
      artifact_snapshot: unknown[];
      created_at: string;
    }>;
  };
};

export type CurrentArtifactVersion = {
  artifact_type: "draft" | "tabular_review";
  artifact_id: string;
  purpose: string;
  current_version_id: string | null;
  current_version_number: number | null;
  current_filename: string | null;
  current_file_type: string | null;
  current_version_available: boolean;
  approved_version_id: string | null;
  approved_version_number: number | null;
  current_revision_fingerprint: string | null;
  approved_revision_fingerprint: string | null;
  approved_snapshot_state: "current" | "legacy_tabular" | "invalid" | null;
  edited_after_approval: boolean;
  review_current_required: boolean;
};

export type AgentReviewVersionState = {
  latest_approved_decision_id: string | null;
  latest_approved_at: string | null;
  has_previous_approval: boolean;
  has_unapproved_changes: boolean;
  current_artifacts: CurrentArtifactVersion[];
};

export function controlledAgentReviewArtifactLinks(snapshot: TaskSnapshot) {
  const generatedLinks = snapshot.artifacts.filter(
    (
      artifact,
    ): artifact is AgentArtifactLinkInput & {
      artifact_type: "draft" | "tabular_review";
    } =>
      artifact.artifact_type === "draft" ||
      artifact.artifact_type === "tabular_review",
  );
  return requiredTaskDeliverables(snapshot.task).flatMap((deliverable) => {
    if (
      !["draft", "tabular_review"].includes(deliverable.artifact_type ?? "")
    ) {
      return [];
    }
    const found = findDeliverableArtifact(deliverable, generatedLinks);
    return found
      ? [
          {
            ...found,
            artifact_type: found.artifact_type as "draft" | "tabular_review",
            purpose: taskDeliverablePurpose(deliverable),
          },
        ]
      : [];
  });
}

export function buildAgentReviewVersionState(
  links: ReturnType<typeof controlledAgentReviewArtifactLinks>,
  documents: Array<{ id: string; current_version_id: string | null }>,
  versions: Array<{
    id: string;
    document_id: string;
    version_number: number | null;
    filename: string | null;
    file_type: string | null;
    deleted_at: string | null;
  }>,
  latestApproved: {
    id: string;
    created_at: string;
    artifact_snapshot: unknown[];
  } | null,
  tabularReviews: Array<{ id: string }> = [],
  currentTabularRevisions: Map<string, string | null> = new Map(),
): AgentReviewVersionState {
  const documentById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const approvedArtifacts = Array.isArray(latestApproved?.artifact_snapshot)
    ? latestApproved.artifact_snapshot.map(readApprovedArtifactSnapshot)
    : [];
  const linkIdentityKeys = links.map(
    (link) => `${link.artifact_type}:${link.artifact_id}`,
  );
  const approvedIdentityKeys = approvedArtifacts.map((item) =>
    item.state === "invalid"
      ? null
      : `${item.artifact.artifact_type}:${item.artifact.artifact_id}`,
  );
  const approvalSnapshotGloballyValid =
    !latestApproved ||
    (approvedArtifacts.length === links.length &&
      approvedIdentityKeys.every((key) => key !== null) &&
      new Set(approvedIdentityKeys).size === approvedIdentityKeys.length &&
      new Set(linkIdentityKeys).size === linkIdentityKeys.length &&
      linkIdentityKeys.every(
        (key) =>
          approvedIdentityKeys.filter((candidate) => candidate === key)
            .length === 1,
      ));
  const tabularReviewIds = new Set(tabularReviews.map((review) => review.id));
  const currentArtifacts = links.map((link) => {
    const approvedRead =
      approvedArtifacts.find(
        (item) =>
          item.state !== "invalid" &&
          item.artifact.artifact_id === link.artifact_id,
      ) ?? null;
    const approvedSnapshotInvalid = Boolean(
      latestApproved &&
      (!approvalSnapshotGloballyValid ||
        !approvedRead ||
        approvedRead.state === "invalid" ||
        (link.artifact_type === "draft" &&
          (approvedRead.state !== "current" ||
            approvedRead.artifact.artifact_type !== "draft")) ||
        (link.artifact_type === "tabular_review" &&
          (approvedRead.state === "legacy_tabular"
            ? false
            : approvedRead.state !== "current" ||
              approvedRead.artifact.artifact_type !== "tabular_review"))),
    );
    if (link.artifact_type === "tabular_review") {
      const available = tabularReviewIds.has(link.artifact_id);
      const approved =
        approvedRead?.state === "current" &&
        approvedRead.artifact.artifact_type === "tabular_review"
          ? approvedRead.artifact
          : null;
      const legacy = approvedRead?.state === "legacy_tabular";
      const currentRevision =
        currentTabularRevisions.get(link.artifact_id) ?? null;
      const differs = Boolean(
        approved &&
        (!currentRevision || currentRevision !== approved.revision_fingerprint),
      );
      return {
        artifact_type: link.artifact_type,
        artifact_id: link.artifact_id,
        purpose: link.purpose,
        current_version_id: null,
        current_version_number: null,
        current_filename: null,
        current_file_type: null,
        current_version_available: available,
        approved_version_id: approved?.export_version_id ?? null,
        approved_version_number: approved?.version_number ?? null,
        current_revision_fingerprint: currentRevision,
        approved_revision_fingerprint: approved?.revision_fingerprint ?? null,
        approved_snapshot_state: approvedSnapshotInvalid
          ? "invalid"
          : legacy
            ? "legacy_tabular"
            : approved
              ? "current"
              : null,
        edited_after_approval: Boolean(legacy || differs),
        review_current_required:
          approvedSnapshotInvalid ||
          Boolean(legacy) ||
          Boolean(approved && differs) ||
          !available,
      } satisfies CurrentArtifactVersion;
    }
    const currentVersionId =
      documentById.get(link.artifact_id)?.current_version_id ?? null;
    const currentVersion = currentVersionId
      ? (versionById.get(currentVersionId) ?? null)
      : null;
    const approved =
      approvedRead?.state === "current" &&
      approvedRead.artifact.artifact_type === "draft"
        ? approvedRead.artifact
        : null;
    const currentVersionAvailable = Boolean(
      currentVersion && !currentVersion.deleted_at,
    );
    const differs = Boolean(
      approved && currentVersionId !== approved.version_id,
    );
    const unavailableAfterApproval = Boolean(
      approved && !currentVersionAvailable,
    );
    return {
      artifact_type: link.artifact_type,
      artifact_id: link.artifact_id,
      purpose: link.purpose,
      current_version_id: currentVersionId,
      current_version_number: currentVersion?.version_number ?? null,
      current_filename: currentVersion?.filename?.trim() || null,
      current_file_type: currentVersion?.file_type ?? null,
      current_version_available: currentVersionAvailable,
      approved_version_id: approved?.version_id ?? null,
      approved_version_number: approved?.version_number ?? null,
      current_revision_fingerprint: null,
      approved_revision_fingerprint: null,
      approved_snapshot_state: approvedSnapshotInvalid
        ? "invalid"
        : approved
          ? "current"
          : null,
      edited_after_approval: Boolean(
        approvedSnapshotInvalid || (currentVersionId && differs),
      ),
      review_current_required:
        approvedSnapshotInvalid || differs || unavailableAfterApproval,
    } satisfies CurrentArtifactVersion;
  });
  return {
    latest_approved_decision_id: latestApproved?.id ?? null,
    latest_approved_at: latestApproved?.created_at ?? null,
    has_previous_approval: Boolean(latestApproved),
    has_unapproved_changes: currentArtifacts.some(
      (artifact) => artifact.review_current_required,
    ),
    current_artifacts: currentArtifacts,
  };
}

export function deriveAgentReviewStatus(
  taskStatus: string,
  latestStatus: AgentReviewStatus | null,
  versionState: AgentReviewVersionState,
): AgentReviewStatus | null {
  const status =
    latestStatus ?? (taskStatus === "completed" ? "review_required" : null);
  return status === "approved" && versionState.has_unapproved_changes
    ? "review_required"
    : status;
}

export async function getAgentReviewVersionState(
  db: Db,
  snapshot: TaskSnapshot,
  userId: string,
): Promise<AgentReviewVersionState> {
  const links = controlledAgentReviewArtifactLinks(snapshot);
  const latestApproved =
    [...(snapshot.review?.decisions ?? [])]
      .reverse()
      .find((decision) => decision.status === "approved") ?? null;
  if (!links.length) {
    return buildAgentReviewVersionState([], [], [], latestApproved);
  }
  const draftDocumentIds = Array.from(
    new Set(
      links
        .filter((artifact) => artifact.artifact_type === "draft")
        .map((artifact) => artifact.artifact_id),
    ),
  );
  const tabularReviewIds = Array.from(
    new Set(
      links
        .filter((artifact) => artifact.artifact_type === "tabular_review")
        .map((artifact) => artifact.artifact_id),
    ),
  );
  const { data: documents, error: documentError } = draftDocumentIds.length
    ? await db
        .from("documents")
        .select("id,current_version_id")
        .in("id", draftDocumentIds)
        .eq("user_id", userId)
        .eq("project_id", snapshot.task.matter_id)
    : { data: [], error: null };
  if (documentError) throw new Error(documentError.message);
  const versionIds = (documents ?? [])
    .map((document) => document.current_version_id as string | null)
    .filter((id): id is string => Boolean(id));
  const { data: versions, error: versionError } = versionIds.length
    ? await db
        .from("document_versions")
        .select("id,document_id,version_number,filename,file_type,deleted_at")
        .in("id", versionIds)
    : { data: [], error: null };
  if (versionError) throw new Error(versionError.message);
  const { data: tabularReviews, error: tabularReviewsError } =
    tabularReviewIds.length
      ? await db
          .from("tabular_reviews")
          .select("id,project_id,user_id,row_protocol")
          .in("id", tabularReviewIds)
      : { data: [], error: null };
  if (tabularReviewsError) throw new Error(tabularReviewsError.message);

  const approvedArtifacts = Array.isArray(latestApproved?.artifact_snapshot)
    ? latestApproved.artifact_snapshot.map(readApprovedArtifactSnapshot)
    : [];
  const currentTabularRevisions = new Map<string, string | null>();
  for (const approved of approvedArtifacts) {
    if (
      approved.state !== "current" ||
      approved.artifact.artifact_type !== "tabular_review"
    ) {
      continue;
    }
    const { data, error } = await db.rpc(
      "read_agent_tabular_review_revision_fingerprint_v1",
      {
        p_task_id: snapshot.task.id,
        p_user_id: userId,
        p_review_id: approved.artifact.review_id,
        p_expected_input_digest: approved.artifact.input_digest,
      },
    );
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as Record<
      string,
      unknown
    > | null;
    currentTabularRevisions.set(
      approved.artifact.review_id,
      row?.outcome === "current" &&
        typeof row.revision_fingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(row.revision_fingerprint)
        ? row.revision_fingerprint
        : null,
    );
  }
  return buildAgentReviewVersionState(
    links,
    (documents ?? []) as Array<{
      id: string;
      current_version_id: string | null;
    }>,
    (versions ?? []) as Array<{
      id: string;
      document_id: string;
      version_number: number | null;
      filename: string | null;
      file_type: string | null;
      deleted_at: string | null;
    }>,
    latestApproved,
    (
      (tabularReviews ?? []) as Array<{
        id: string;
        project_id: string | null;
        user_id: string | null;
        row_protocol: string | null;
      }>
    ).filter(
      (review) =>
        review.project_id === snapshot.task.matter_id &&
        review.user_id === userId &&
        review.row_protocol === "document_rows",
    ),
    currentTabularRevisions,
  );
}
