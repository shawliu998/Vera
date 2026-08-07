import {
  findDeliverableArtifact,
  requiredTaskDeliverables,
} from "./agentTaskDeliverables";
import {
  AgentTaskArtifactReverificationError,
  startAgentTaskArtifactReverification,
} from "./agent-kernel/verification/artifactReverification";
import { isAgentTaskStateTransitionError } from "./agent-kernel/execution/taskTransition";
import { getAgentTaskSnapshot } from "./agentTasks";
import {
  appendCurrentDocxVersion,
  CurrentDocumentVersionMutationError,
  durableCurrentVersionMutationId,
  semanticDocxDigest,
} from "./currentDocumentVersionMutation";
import { createServerSupabase } from "./supabase";
import {
  advanceTaskWordArtifactReceipt,
  readTaskWordArtifactReceipt,
  sameTaskWordArtifactReceipt,
  TaskWordArtifactReceiptError,
  type TaskWordArtifactReceiptV1,
} from "./taskWordArtifactReceipt";
import { downloadFile } from "./storage";
import { canonicalUuidIdentity, sameUuidIdentity } from "./uuidIdentity";
import {
  evaluateAgentTaskExecutionRecovery,
  type AgentTaskExecutionRecovery,
} from "./agent-kernel/recovery/executionRecovery";

type Db = ReturnType<typeof createServerSupabase>;
type Snapshot = NonNullable<Awaited<ReturnType<typeof getAgentTaskSnapshot>>>;

const TASK_WORD_EDIT_IDENTITY_VERSION = "agent-task-word-artifact-edit-v1";

export type AgentTaskWordArtifactReverificationIssue = {
  issue_code: Exclude<AgentTaskExecutionRecovery["issue_code"], null>;
  recovery_action: "start_new_task";
  detail: string;
};

export class AgentTaskWordArtifactError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    public readonly code:
      | "invalid_docx"
      | "task_not_found"
      | "artifact_not_found"
      | "identity_mismatch"
      | "version_conflict"
      | "reverification_conflict"
      | "reverification_unavailable",
    message: string,
    public readonly preservedVersion: AgentTaskWordArtifactVersion | null = null,
    public readonly reverificationIssue: AgentTaskWordArtifactReverificationIssue | null = null,
  ) {
    super(message);
    this.name = "AgentTaskWordArtifactError";
  }
}

export function agentTaskWordArtifactErrorBody(
  error: AgentTaskWordArtifactError,
) {
  return {
    detail: error.message,
    issue_code: error.code,
    preserved_version: error.preservedVersion,
    ...(error.reverificationIssue
      ? { reverification_issue: error.reverificationIssue }
      : {}),
  };
}

export type AgentTaskWordArtifactVersion = {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  filename: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  artifact_reverification?: {
    outcome: "started" | "already_started";
    task_status: string | null;
    current_step: string | null;
  };
};

function assertTaskWordArtifact(
  snapshot: Snapshot,
  receipt: TaskWordArtifactReceiptV1,
) {
  const deliverable = requiredTaskDeliverables(snapshot.task).find(
    (candidate) => candidate.key === receipt.deliverableKey,
  );
  const artifact = deliverable
    ? findDeliverableArtifact(deliverable, snapshot.artifacts)
    : null;
  if (
    !sameUuidIdentity(snapshot.task.id, receipt.taskId) ||
    !sameUuidIdentity(snapshot.task.matter_id, receipt.projectId) ||
    !deliverable ||
    deliverable.artifact_type !== "draft" ||
    !artifact ||
    artifact.artifact_type !== "draft" ||
    !sameUuidIdentity(artifact.artifact_id, receipt.documentId)
  ) {
    throw new AgentTaskWordArtifactError(
      409,
      "identity_mismatch",
      "The Word file is not the current declared draft for this Task.",
    );
  }
}

async function loadBaseBytes(
  db: Db,
  documentId: string,
  baseVersionId: string,
) {
  const { data, error } = await db
    .from("document_versions")
    .select("id,document_id,storage_path,file_type,deleted_at")
    .eq("id", baseVersionId)
    .eq("document_id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !data ||
    data.deleted_at ||
    typeof data.storage_path !== "string" ||
    !data.storage_path.trim() ||
    String(data.file_type).toLowerCase() !== "docx"
  ) {
    throw new AgentTaskWordArtifactError(
      409,
      "version_conflict",
      "The Task Word artifact base Version is unavailable.",
    );
  }
  const bytes = await downloadFile(data.storage_path);
  if (!bytes) {
    throw new AgentTaskWordArtifactError(
      409,
      "version_conflict",
      "The Task Word artifact base Version bytes are unavailable.",
    );
  }
  return Buffer.from(bytes);
}

async function loadPersistedVersion(
  db: Db,
  documentId: string,
  versionId: string,
) {
  const { data, error } = await db
    .from("document_versions")
    .select(
      "id,version_number,source,created_at,filename,file_type,size_bytes,page_count,deleted_at",
    )
    .eq("id", versionId)
    .eq("document_id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.deleted_at) {
    throw new AgentTaskWordArtifactError(
      409,
      "version_conflict",
      "The Task Word artifact successor Version is unavailable.",
    );
  }
  return data as AgentTaskWordArtifactVersion;
}

export async function putAgentTaskWordArtifactEdit(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    documentId: string;
    baseVersionId: string;
    filename: string;
    buffer: Buffer;
    dependencies?: {
      loadSnapshot?: typeof getAgentTaskSnapshot;
      loadBaseBytes?: typeof loadBaseBytes;
      readReceipt?: typeof readTaskWordArtifactReceipt;
      advanceReceipt?: typeof advanceTaskWordArtifactReceipt;
      semanticDigest?: typeof semanticDocxDigest;
      appendVersion?: typeof appendCurrentDocxVersion;
      loadPersistedVersion?: typeof loadPersistedVersion;
      startReverification?: typeof startAgentTaskArtifactReverification;
      evaluateExecutionRecovery?: typeof evaluateAgentTaskExecutionRecovery;
    };
  },
): Promise<AgentTaskWordArtifactVersion> {
  if (
    !input.filename.toLowerCase().endsWith(".docx") ||
    input.buffer.byteLength === 0
  ) {
    throw new AgentTaskWordArtifactError(
      400,
      "invalid_docx",
      "A non-empty DOCX file is required.",
    );
  }
  const loadSnapshot = input.dependencies?.loadSnapshot ?? getAgentTaskSnapshot;
  const snapshot = await loadSnapshot(db, input.taskId, input.userId);
  if (!snapshot) {
    throw new AgentTaskWordArtifactError(
      404,
      "task_not_found",
      "Agent task not found.",
    );
  }
  const executionRecovery = (
    input.dependencies?.evaluateExecutionRecovery ??
    evaluateAgentTaskExecutionRecovery
  )(snapshot.task);
  const readReceipt =
    input.dependencies?.readReceipt ?? readTaskWordArtifactReceipt;
  let predecessor: TaskWordArtifactReceiptV1 | null;
  try {
    predecessor = await readReceipt(input.buffer);
  } catch (error) {
    throw new AgentTaskWordArtifactError(
      400,
      "invalid_docx",
      error instanceof TaskWordArtifactReceiptError
        ? error.message
        : "The edited file is not a valid DOCX.",
    );
  }
  if (
    !predecessor ||
    !sameUuidIdentity(predecessor.taskId, input.taskId) ||
    !sameUuidIdentity(predecessor.projectId, snapshot.task.matter_id) ||
    !sameUuidIdentity(predecessor.documentId, input.documentId) ||
    !sameUuidIdentity(predecessor.versionId, input.baseVersionId)
  ) {
    throw new AgentTaskWordArtifactError(
      409,
      "identity_mismatch",
      "The open Word file identity does not match this Task, Matter, draft, and base Version.",
    );
  }
  assertTaskWordArtifact(snapshot, predecessor);

  const loadBase = input.dependencies?.loadBaseBytes ?? loadBaseBytes;
  const serverBaseBytes = await loadBase(
    db,
    input.documentId,
    input.baseVersionId,
  );
  let serverBaseReceipt: TaskWordArtifactReceiptV1 | null;
  try {
    serverBaseReceipt = await readReceipt(serverBaseBytes);
  } catch {
    throw new AgentTaskWordArtifactError(
      409,
      "identity_mismatch",
      "The server-stored base Version has an invalid Word identity.",
    );
  }
  if (
    !serverBaseReceipt ||
    !sameTaskWordArtifactReceipt(serverBaseReceipt, predecessor)
  ) {
    throw new AgentTaskWordArtifactError(
      409,
      "identity_mismatch",
      "The open Word file identity does not match the server-stored base Version.",
    );
  }

  const taskIdentity = canonicalUuidIdentity(input.taskId);
  const documentIdentity = canonicalUuidIdentity(input.documentId);
  const baseIdentity = canonicalUuidIdentity(input.baseVersionId);
  if (!taskIdentity || !documentIdentity || !baseIdentity) {
    throw new AgentTaskWordArtifactError(
      400,
      "identity_mismatch",
      "The Task Word artifact identity is invalid.",
    );
  }
  const digest = input.dependencies?.semanticDigest ?? semanticDocxDigest;
  let editDigest: string;
  try {
    editDigest = await digest(input.buffer);
  } catch {
    throw new AgentTaskWordArtifactError(
      400,
      "invalid_docx",
      "The edited file is not a valid DOCX.",
    );
  }
  const mutationKey = [
    TASK_WORD_EDIT_IDENTITY_VERSION,
    taskIdentity,
    documentIdentity,
    baseIdentity,
    predecessor.deliverableKey,
    editDigest,
  ].join(":");
  const successor: TaskWordArtifactReceiptV1 = {
    ...predecessor,
    versionId: durableCurrentVersionMutationId(mutationKey),
  };
  const advanceReceipt =
    input.dependencies?.advanceReceipt ?? advanceTaskWordArtifactReceipt;
  let persistedBuffer: Buffer;
  try {
    persistedBuffer = await advanceReceipt(input.buffer, {
      predecessor,
      successor,
    });
  } catch (error) {
    throw new AgentTaskWordArtifactError(
      409,
      "identity_mismatch",
      error instanceof Error
        ? error.message
        : "The Task Word artifact successor identity could not be persisted.",
    );
  }
  const appendVersion =
    input.dependencies?.appendVersion ?? appendCurrentDocxVersion;
  let appended;
  try {
    appended = await appendVersion({
      db,
      userId: input.userId,
      projectId: snapshot.task.matter_id,
      documentId: input.documentId,
      baseVersionId: input.baseVersionId,
      mutationKey,
      filename: input.filename,
      buffer: persistedBuffer,
      beforeActivate: async () => {
        const current = await loadSnapshot(db, input.taskId, input.userId);
        if (!current) {
          throw new AgentTaskWordArtifactError(
            404,
            "task_not_found",
            "Agent task not found.",
          );
        }
        assertTaskWordArtifact(current, successor);
      },
    });
  } catch (error) {
    if (error instanceof AgentTaskWordArtifactError) throw error;
    if (error instanceof CurrentDocumentVersionMutationError) {
      throw new AgentTaskWordArtifactError(
        error.code === "invalid_docx" ? 400 : 409,
        error.code === "invalid_docx" ? "invalid_docx" : "version_conflict",
        error.message,
      );
    }
    throw error;
  }
  if (!sameUuidIdentity(appended.version_id, successor.versionId)) {
    throw new AgentTaskWordArtifactError(
      409,
      "version_conflict",
      "The Task Word artifact successor Version identity is invalid.",
    );
  }
  const loadVersion =
    input.dependencies?.loadPersistedVersion ?? loadPersistedVersion;
  const version = await loadVersion(db, input.documentId, appended.version_id);
  if (!executionRecovery.allowed) {
    throw new AgentTaskWordArtifactError(
      409,
      "reverification_conflict",
      executionRecovery.detail,
      version,
      {
        issue_code: executionRecovery.issue_code,
        recovery_action: "start_new_task",
        detail: executionRecovery.detail,
      },
    );
  }
  const startReverification =
    input.dependencies?.startReverification ??
    startAgentTaskArtifactReverification;
  try {
    const transition = await startReverification(db, {
      taskId: input.taskId,
      userId: input.userId,
      documentId: input.documentId,
      baseVersionId: input.baseVersionId,
      versionId: appended.version_id,
      mutationId: `agent-task-word-artifact:${appended.version_id}`,
    });
    return {
      ...version,
      artifact_reverification: {
        outcome: transition.outcome,
        task_status: transition.taskStatus,
        current_step: transition.currentStep,
      },
    };
  } catch (error) {
    if (error instanceof AgentTaskArtifactReverificationError) {
      throw new AgentTaskWordArtifactError(
        error.outcome === "not_found" || error.outcome === "artifact_not_found"
          ? 404
          : 409,
        "reverification_conflict",
        error.message,
        version,
      );
    }
    if (isAgentTaskStateTransitionError(error)) {
      throw new AgentTaskWordArtifactError(
        503,
        "reverification_unavailable",
        "The edited Version was preserved, but re-verification is temporarily unavailable. Retrying this save is safe.",
        version,
      );
    }
    throw error;
  }
}
