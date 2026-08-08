import { createHash } from "crypto";
import { verifyTaskCitationLinks } from "./agentStepExecutor";
import type { AgentArtifactLinkInput } from "./agentTasks";
import { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import { evaluateTaskDeliverables } from "./agentTaskDeliverables";
import { readAgentStepReceipts } from "./agent-kernel/contracts/stepContract";
import {
  approvedArtifactSnapshotSchema,
  readApprovedArtifactSnapshot,
  type ApprovedArtifactSnapshot,
} from "./agentApprovedArtifactSnapshot";
import {
  materializeApprovedLitigationEvidenceInventoryXlsx,
  type ApprovedTabularExportMaterialization,
} from "./agentTabularApprovedExport";
import { litigationEvidenceInventoryReceiptSchema } from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  controlledAgentReviewArtifactLinks,
  getAgentReviewVersionState,
} from "./agentTaskReviewVersions";
import { readAgentVerificationRecordV1 } from "./agent-kernel/verification/verifierCore";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentReviewStatus =
  | "review_required"
  | "changes_requested"
  | "approved";

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
      position?: number;
      status: string;
      attempt?: number;
      result_summary: string | null;
    }>;
    latest_checkpoint?: unknown;
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

export type AgentTaskReviewDependencies = {
  download?: typeof downloadFile;
  materializeApprovedTabular?: (input: {
    db: Db;
    snapshot: TaskSnapshot;
    userId: string;
    reviewId: string;
    purpose: string;
  }) => Promise<ApprovedTabularExportMaterialization>;
};

export type ApprovedExportDependencies = {
  download?: typeof downloadFile;
  verifyLock?: (input: {
    taskId: string;
    userId: string;
    decisionId: string;
    documentId: string;
    versionId: string;
  }) => Promise<boolean>;
};

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function approvedArtifactBytesMatch(
  artifact: { sha256: string },
  bytes: Uint8Array,
) {
  return sha256(bytes) === artifact.sha256;
}

export function structuredVerifierBindingIssue(input: {
  taskId: string;
  checkpoint: unknown;
  verifier: { id: string; attempt?: number };
  receipt: { capability: string; outcome: string; attempt: number };
}) {
  if (input.receipt.capability !== "verify") {
    return "The final Step has no structured Verifier receipt.";
  }
  const verificationRecord = readAgentVerificationRecordV1(input.checkpoint);
  const expectedOutcome =
    input.receipt.outcome === "review_required"
      ? "review_required"
      : input.receipt.outcome === "postconditions_satisfied"
        ? "clean_pass"
        : null;
  if (
    !expectedOutcome ||
    verificationRecord.state !== "valid" ||
    verificationRecord.record.task_id !== input.taskId ||
    verificationRecord.record.step_id !== input.verifier.id ||
    verificationRecord.record.step_attempt !== input.receipt.attempt ||
    verificationRecord.record.step_attempt !== input.verifier.attempt ||
    verificationRecord.record.result.outcome !== expectedOutcome
  ) {
    return "The current structured Verifier result is unavailable or does not match the final Step.";
  }
  return null;
}

export async function getApprovalBlockers(
  db: Db,
  snapshot: TaskSnapshot,
  userId: string,
) {
  const base = await getReviewBlockers(db, snapshot, userId);
  const versionState = await getAgentReviewVersionState(db, snapshot, userId);
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
      const issue = structuredVerifierBindingIssue({
        taskId: snapshot.task.id,
        checkpoint: snapshot.task.latest_checkpoint,
        verifier,
        receipt: verifierReceipt,
      });
      if (issue) blockers.push(issue);
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
  userId: string,
  dependencies: AgentTaskReviewDependencies = {},
): Promise<ApprovedArtifactSnapshot[]> {
  const links = controlledAgentReviewArtifactLinks(snapshot);
  const draftLinks = links.filter((link) => link.artifact_type === "draft");
  const documentIds = Array.from(
    new Set(draftLinks.map((artifact) => artifact.artifact_id)),
  );
  const { data: documents, error: documentError } = documentIds.length
    ? await db
        .from("documents")
        .select("id,current_version_id")
        .in("id", documentIds)
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

  const capturedByLink = new Map<
    (typeof links)[number],
    ApprovedArtifactSnapshot
  >();
  // Read and validate every existing Draft first. A later Draft failure must
  // not leave an otherwise unnecessary Tabular storage object behind.
  for (const link of draftLinks) {
    const version = versionByDocument.get(link.artifact_id);
    if (!version?.id || !version.storage_path) {
      throw new Error(`No exportable version exists for ${link.purpose}.`);
    }
    const raw = await (dependencies.download ?? downloadFile)(
      version.storage_path as string,
    );
    if (!raw) throw new Error(`Stored bytes are missing for ${link.purpose}.`);
    const bytes = Buffer.from(raw);
    capturedByLink.set(
      link,
      approvedArtifactSnapshotSchema.parse({
        artifact_type: "draft",
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
      }),
    );
  }
  const checkpoint =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? (snapshot.task.latest_checkpoint as Record<string, unknown>)
      : null;
  for (const link of links.filter(
    (candidate) => candidate.artifact_type === "tabular_review",
  )) {
    const litigationReceipt =
      litigationEvidenceInventoryReceiptSchema.safeParse(
        checkpoint?.litigation_evidence_inventory_receipt,
      );
    if (
      !litigationReceipt.success ||
      litigationReceipt.data.task_id !== snapshot.task.id ||
      litigationReceipt.data.matter_id !== snapshot.task.matter_id ||
      litigationReceipt.data.review_id !== link.artifact_id
    ) {
      throw new Error(
        `No server approval materializer is registered for ${link.purpose}.`,
      );
    }
    const materialize =
      dependencies.materializeApprovedTabular ??
      materializeApprovedLitigationEvidenceInventoryXlsx;
    const materialized = await materialize({
      db,
      snapshot,
      userId,
      reviewId: link.artifact_id,
      purpose: link.purpose,
    });
    capturedByLink.set(link, materialized.artifact);
  }
  return links.map((link) => {
    const artifact = capturedByLink.get(link);
    if (!artifact) {
      throw new Error(`No approved artifact was captured for ${link.purpose}.`);
    }
    return artifact;
  });
}

export async function loadApprovedExport(
  db: Db,
  taskId: string,
  userId: string,
  artifactId: string,
  dependencies: ApprovedExportDependencies = {},
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
  if (!Array.isArray(decision.artifact_snapshot)) {
    throw new Error("The approved version snapshot is malformed.");
  }
  const artifacts = decision.artifact_snapshot.map(
    readApprovedArtifactSnapshot,
  );
  if (artifacts.some((artifact) => artifact.state === "invalid")) {
    throw new Error("The approved version snapshot is malformed.");
  }
  if (artifacts.some((artifact) => artifact.state === "legacy_tabular")) {
    throw new Error(
      "This historical approval Decision contains Tabular state with no fixed approved export bytes.",
    );
  }
  const matching = artifacts.flatMap((item) =>
    item.state === "current" && item.artifact.artifact_id === artifactId
      ? [item.artifact]
      : [],
  );
  if (matching.length !== 1) {
    throw new Error(
      "This artifact is not part of the approved version snapshot.",
    );
  }
  const locked = matching[0]!;
  const documentId =
    locked.artifact_type === "draft"
      ? locked.document_id
      : locked.export_document_id;
  const versionId =
    locked.artifact_type === "draft"
      ? locked.version_id
      : locked.export_version_id;

  const { data: version, error: versionError } = await db
    .from("document_versions")
    .select(
      "id,document_id,storage_path,version_number,filename,file_type,size_bytes,deleted_at",
    )
    .eq("id", versionId)
    .eq("document_id", documentId)
    .maybeSingle();
  if (versionError) throw new Error(versionError.message);
  if (!version?.storage_path || version.deleted_at) {
    throw new Error("The approved artifact version is no longer available.");
  }
  const storedFilename =
    typeof version.filename === "string" && version.filename.trim()
      ? version.filename.trim()
      : "Approved artifact";
  if (
    version.version_number !== locked.version_number ||
    storedFilename !== locked.filename ||
    version.file_type !== locked.file_type ||
    version.size_bytes !== locked.size_bytes
  ) {
    throw new Error("The approved artifact metadata no longer matches.");
  }
  const verifyLock =
    dependencies.verifyLock ??
    (async (lockInput) => {
      const { data, error } = await db.rpc("verify_approved_export_lock", {
        p_task_id: lockInput.taskId,
        p_user_id: lockInput.userId,
        p_decision_id: lockInput.decisionId,
        p_document_id: lockInput.documentId,
        p_version_id: lockInput.versionId,
      });
      if (error) throw new Error(error.message);
      return data === true;
    });
  const lockInput = {
    taskId,
    userId,
    decisionId: String(decision.id),
    documentId,
    versionId,
  };
  if (!(await verifyLock(lockInput))) {
    throw new Error(
      "Final export is blocked because the approved version lock changed.",
    );
  }
  const download = dependencies.download ?? downloadFile;
  const raw = await download(version.storage_path as string);
  if (!raw) throw new Error("The approved artifact bytes are unavailable.");
  const bytes = Buffer.from(raw);
  if (
    bytes.byteLength !== locked.size_bytes ||
    !approvedArtifactBytesMatch(locked, bytes)
  ) {
    throw new Error(
      "The approved artifact failed its SHA-256 integrity check.",
    );
  }
  if (!(await verifyLock(lockInput))) {
    throw new Error(
      "Final export is blocked because the approved version lock changed.",
    );
  }
  return { bytes, artifact: locked, decision };
}
