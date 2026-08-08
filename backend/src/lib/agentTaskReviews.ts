import { createHash } from "crypto";
import { verifyTaskCitationLinks } from "./agentStepExecutor";
import type { AgentArtifactLinkInput } from "./agentTasks";
import { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import { evaluateTaskDeliverables } from "./agentTaskDeliverables";
import { readAgentStepReceipts } from "./agent-kernel/contracts/stepContract";
import {
  controlledAgentReviewArtifactLinks,
  getAgentReviewVersionState,
} from "./agentTaskReviewVersions";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentReviewStatus =
  "review_required" | "changes_requested" | "approved";

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
    current_plan: Array<{
      id: string;
      status: string;
      result_summary: string | null;
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

export type ApprovedArtifactSnapshot = {
  artifact_type: "draft" | "tabular_review";
  artifact_id: string;
  purpose: string;
  document_id: string;
  version_id: string;
  version_number: number | null;
  filename: string;
  file_type: string | null;
  size_bytes: number;
  sha256: string;
};

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function approvedArtifactBytesMatch(
  artifact: Pick<ApprovedArtifactSnapshot, "sha256">,
  bytes: Uint8Array,
) {
  return sha256(bytes) === artifact.sha256;
}

export async function getApprovalBlockers(
  db: Db,
  snapshot: TaskSnapshot,
  userId: string,
) {
  const base = await getReviewBlockers(db, snapshot, userId);
  const versionState = await getAgentReviewVersionState(db, snapshot);
  const unavailable = versionState.current_artifacts.filter(
    (artifact) => !artifact.current_version_available,
  );
  return {
    ...base,
    versionState,
    blockers: [
      ...base.blockers,
      ...unavailable.map(
        (artifact) => `The current ${artifact.purpose} version is unavailable.`,
      ),
    ],
  };
}

export async function getReviewBlockers(
  db: Db,
  snapshot: TaskSnapshot,
  userId: string,
) {
  const blockers: string[] = [];
  if (snapshot.task.status !== "completed") {
    blockers.push(
      "The work task has not completed execution and verification.",
    );
  }

  const deliverables = await evaluateTaskDeliverables(db, snapshot, { userId });
  for (const title of deliverables.missing) {
    blockers.push(`The required ${title} is missing.`);
  }
  for (const title of deliverables.outsideMatter) {
    blockers.push(`The required ${title} does not belong to this Matter.`);
  }

  const verifier = snapshot.task.current_plan.at(-1);
  if (!verifier || verifier.status !== "completed") {
    blockers.push("The Verifier has not completed all required checks.");
  } else {
    const verifierReceipt = readAgentStepReceipts(
      (snapshot.task as { latest_checkpoint?: unknown }).latest_checkpoint,
    ).at(-1);
    if (verifierReceipt?.capability === "verify") {
      if (verifierReceipt.outcome === "review_required") {
        blockers.push("The Verifier reported one or more unresolved gaps.");
      }
    } else if (
      /\bGAP\b/i.test(verifier.result_summary ?? "") &&
      !/\bno\b[^.]{0,80}\bgap\b/i.test(verifier.result_summary ?? "")
    ) {
      blockers.push("The Verifier reported one or more unresolved gaps.");
    }
  }

  const incomplete = snapshot.task.current_plan
    .slice(0, -1)
    .filter((step) => step.status !== "completed");
  if (incomplete.length) {
    blockers.push(
      `${incomplete.length} work step${incomplete.length === 1 ? " is" : "s are"} incomplete.`,
    );
  }

  const citationCheck = await verifyTaskCitationLinks(
    db,
    snapshot as never,
    userId,
  );
  const hasSources = snapshot.artifacts.some(
    (artifact) =>
      artifact.artifact_type === "document" &&
      artifact.purpose === "Source document",
  );
  if (hasSources && citationCheck.total === 0) {
    blockers.push("No source citations are available for relocation checks.");
  } else if (hasSources && citationCheck.missing > 0) {
    blockers.push(
      `${citationCheck.missing} source citation${citationCheck.missing === 1 ? "" : "s"} could not be relocated.`,
    );
  }

  return { blockers, citationCheck, verifier };
}

export async function captureApprovedArtifacts(
  db: Db,
  snapshot: TaskSnapshot,
): Promise<ApprovedArtifactSnapshot[]> {
  const links = controlledAgentReviewArtifactLinks(snapshot);
  const documentIds = Array.from(
    new Set(links.map((artifact) => artifact.artifact_id)),
  );
  if (!documentIds.length) return [];

  const { data: documents, error: documentError } = await db
    .from("documents")
    .select("id,current_version_id")
    .in("id", documentIds);
  if (documentError) throw new Error(documentError.message);
  const versionIds = (documents ?? [])
    .map((document) => document.current_version_id as string | null)
    .filter((id): id is string => Boolean(id));
  const { data: versions, error: versionError } = versionIds.length
    ? await db
        .from("document_versions")
        .select(
          "id,document_id,storage_path,version_number,filename,file_type,size_bytes",
        )
        .in("id", versionIds)
        .is("deleted_at", null)
    : { data: [], error: null };
  if (versionError) throw new Error(versionError.message);
  const versionByDocument = new Map(
    (versions ?? []).map((version) => [version.document_id as string, version]),
  );

  const captured: ApprovedArtifactSnapshot[] = [];
  for (const link of links) {
    const version = versionByDocument.get(link.artifact_id);
    if (!version?.id || !version.storage_path) {
      throw new Error(`No exportable version exists for ${link.purpose}.`);
    }
    const raw = await downloadFile(version.storage_path as string);
    if (!raw) throw new Error(`Stored bytes are missing for ${link.purpose}.`);
    const bytes = Buffer.from(raw);
    captured.push({
      artifact_type: link.artifact_type as "draft" | "tabular_review",
      artifact_id: link.artifact_id,
      purpose: link.purpose,
      document_id: link.artifact_id,
      version_id: version.id as string,
      version_number: (version.version_number as number | null) ?? null,
      filename:
        (version.filename as string | null)?.trim() || "Approved artifact",
      file_type: (version.file_type as string | null) ?? null,
      size_bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return captured;
}

export async function loadApprovedExport(
  db: Db,
  taskId: string,
  userId: string,
  artifactId: string,
) {
  const { data: task } = await db
    .from("agent_tasks")
    .select("id")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!task) return null;

  const { data: decision, error: decisionError } = await db
    .from("agent_task_review_decisions")
    .select("id,status,artifact_snapshot,created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (decisionError) throw new Error(decisionError.message);
  if (!decision) {
    throw new Error(
      "Final export is blocked until the authenticated task owner records an approval.",
    );
  }
  if (decision.status !== "approved") {
    throw new Error(
      "Final export is blocked because the most recent review decision requests changes.",
    );
  }
  const artifacts = Array.isArray(decision.artifact_snapshot)
    ? (decision.artifact_snapshot as ApprovedArtifactSnapshot[])
    : [];
  const locked = artifacts.find(
    (artifact) => artifact.artifact_id === artifactId,
  );
  if (!locked) {
    throw new Error(
      "This artifact is not part of the approved version snapshot.",
    );
  }

  const { data: version, error: versionError } = await db
    .from("document_versions")
    .select("id,document_id,storage_path,deleted_at")
    .eq("id", locked.version_id)
    .eq("document_id", locked.document_id)
    .maybeSingle();
  if (versionError) throw new Error(versionError.message);
  if (!version?.storage_path || version.deleted_at) {
    throw new Error("The approved artifact version is no longer available.");
  }
  const raw = await downloadFile(version.storage_path as string);
  if (!raw) throw new Error("The approved artifact bytes are unavailable.");
  const bytes = Buffer.from(raw);
  if (!approvedArtifactBytesMatch(locked, bytes)) {
    throw new Error(
      "The approved artifact failed its SHA-256 integrity check.",
    );
  }
  return { bytes, artifact: locked, decision };
}
