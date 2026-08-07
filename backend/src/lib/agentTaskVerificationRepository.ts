import { createHash } from "node:crypto";

import { readAgentStepEffectReceipts } from "./agent-kernel/effects/stepEffect";
import { readFixedMatterContext } from "./agent-kernel/context/matterContext";
import {
  buildAgentVerificationPacketV1,
  type AgentVerificationPacketV1,
  type AgentVerifierDeterministicIssueV1,
  type AgentVerifierProfileV1,
} from "./agent-kernel/verification/verifierCore";
import {
  findDeliverableArtifact,
  requiredTaskDeliverables,
  taskDeliverablePurpose,
} from "./agentTaskDeliverables";
import type { AgentArtifactLinkInput } from "./agentTasks";
import { extractDocxBodyText } from "./docxTrackedChanges";
import { spreadsheetToLLMText } from "./spreadsheet";
import { downloadFile } from "./storage";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

type VerificationSnapshot = {
  task: {
    id: string;
    matter_id: string;
    goal: string;
    deliverables?: unknown;
    latest_checkpoint?: unknown;
    current_plan: Array<{
      id: string;
      status: string;
      attempt: number;
      result_data?: unknown;
    }>;
  };
  artifacts: AgentArtifactLinkInput[];
};

type CitationCoverage = {
  total: number;
  relocatable: number;
  missing: number;
};

type MutableCheck = AgentVerificationPacketV1["deterministic_checks"][number];

export const MAX_VERIFIER_DELIVERABLE_PROJECTION_CHARS = 80_000;
export const MAX_VERIFIER_PACKET_PROJECTION_CHARS = 160_000;

function passCheck(
  code: string,
  dimension: MutableCheck["dimension"],
  detail: string,
): MutableCheck {
  return { code, dimension, status: "pass", detail, issue: null };
}

function gapCheck(
  code: string,
  dimension: MutableCheck["dimension"],
  detail: string,
  issue: AgentVerifierDeterministicIssueV1,
): MutableCheck {
  return { code, dimension, status: "gap", detail, issue };
}

function acceptedViewSha256(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function extractAcceptedView(version: {
  storage_path?: string | null;
  file_type?: string | null;
}) {
  if (!version.storage_path) return null;
  const raw = await downloadFile(version.storage_path);
  if (!raw) return null;
  const bytes = Buffer.from(raw);
  const fileType = (version.file_type ?? "").toLowerCase();
  if (fileType === "docx") return extractDocxBodyText(bytes);
  if (["xlsx", "xlsm", "xls"].includes(fileType)) {
    return spreadsheetToLLMText(bytes);
  }
  return null;
}

function fixedCreatedVersionByDocument(snapshot: VerificationSnapshot) {
  const pairs = snapshot.task.current_plan.flatMap((step) =>
    readAgentStepEffectReceipts(step.result_data).flatMap((receipt) =>
      receipt.status === "committed" && receipt.effect
        ? [[receipt.effect.document_id, receipt.effect.version_id] as const]
        : [],
    ),
  );
  return new Map(pairs);
}

function deliverableKey(deliverable: {
  key?: string;
  title?: string;
  purpose?: string;
}) {
  return deliverable.key?.trim() || taskDeliverablePurpose(deliverable);
}

export async function buildCurrentAgentVerificationPacket(input: {
  db: Db;
  snapshot: VerificationSnapshot;
  userId: string;
  stepId: string;
  stepAttempt: number;
  profile: AgentVerifierProfileV1;
  citationsRequired: boolean;
  citationCoverage: CitationCoverage;
  loadAcceptedView?: typeof extractAcceptedView;
}) {
  const required = requiredTaskDeliverables(input.snapshot.task);
  const artifacts = required.map((deliverable) => ({
    deliverable,
    key: deliverableKey(deliverable),
    artifact: findDeliverableArtifact(deliverable, input.snapshot.artifacts),
  }));
  const artifactIds = Array.from(
    new Set(
      artifacts.flatMap(({ artifact }) =>
        artifact ? [artifact.artifact_id] : [],
      ),
    ),
  );
  const { data: documents, error: documentsError } = artifactIds.length
    ? await input.db
        .from("documents")
        .select("id,user_id,project_id,current_version_id")
        .in("id", artifactIds)
    : { data: [], error: null };
  if (documentsError) throw new Error(documentsError.message);
  const documentById = new Map(
    (documents ?? []).map((document) => [document.id as string, document]),
  );
  const currentVersionIds = Array.from(
    new Set(
      (documents ?? []).flatMap((document) =>
        typeof document.current_version_id === "string" &&
        document.current_version_id
          ? [document.current_version_id]
          : [],
      ),
    ),
  );
  const { data: versions, error: versionsError } = currentVersionIds.length
    ? await input.db
        .from("document_versions")
        .select("id,document_id,storage_path,file_type,deleted_at")
        .in("id", currentVersionIds)
    : { data: [], error: null };
  if (versionsError) throw new Error(versionsError.message);
  const versionById = new Map(
    (versions ?? []).map((version) => [version.id as string, version]),
  );
  const expectedVersionByDocument = fixedCreatedVersionByDocument(
    input.snapshot,
  );
  const checks: MutableCheck[] = [];
  const deliverables: AgentVerificationPacketV1["deliverables"] = [];
  let remainingProjectionCharacters = MAX_VERIFIER_PACKET_PROJECTION_CHARS;

  for (const item of artifacts) {
    const artifactType =
      item.deliverable.artifact_type === "tabular_review"
        ? "tabular_review"
        : "draft";
    if (!item.artifact) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: null,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-present:${item.key}`,
          "artifact_integrity",
          `${item.key} has no linked current Artifact.`,
          {
            code: "artifact_missing",
            deliverable_key: item.key,
            artifact_type: artifactType,
          },
        ),
      );
      continue;
    }
    const document = documentById.get(item.artifact.artifact_id);
    if (!document) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-available:${item.key}`,
          "artifact_integrity",
          `${item.key} does not resolve to an available Document.`,
          {
            code: "artifact_unavailable",
            deliverable_key: item.key,
            artifact_id: item.artifact.artifact_id,
          },
        ),
      );
      continue;
    }
    if (
      document.user_id !== input.userId ||
      document.project_id !== input.snapshot.task.matter_id
    ) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-matter:${item.key}`,
          "artifact_integrity",
          `${item.key} is outside the fixed Matter.`,
          {
            code: "artifact_outside_matter",
            deliverable_key: item.key,
            artifact_id: item.artifact.artifact_id,
          },
        ),
      );
      continue;
    }
    const currentVersionId =
      typeof document.current_version_id === "string"
        ? document.current_version_id
        : null;
    const expectedVersionId =
      expectedVersionByDocument.get(document.id as string) ?? currentVersionId;
    if (expectedVersionId && currentVersionId !== expectedVersionId) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: document.id as string,
        current_version_id: currentVersionId,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `artifact-version:${item.key}`,
          "artifact_integrity",
          `${item.key} no longer points to its fixed generated Version.`,
          {
            code: "artifact_version_changed",
            deliverable_key: item.key,
            document_id: document.id as string,
            expected_version_id: expectedVersionId,
            current_version_id: currentVersionId,
          },
        ),
      );
      continue;
    }
    const version = currentVersionId ? versionById.get(currentVersionId) : null;
    let acceptedView: string | null = null;
    if (version && version.document_id === document.id && !version.deleted_at) {
      try {
        acceptedView = await (input.loadAcceptedView ?? extractAcceptedView)(
          version,
        );
      } catch {
        acceptedView = null;
      }
    }
    if (!currentVersionId || !version || acceptedView === null) {
      deliverables.push({
        key: item.key,
        artifact_type: artifactType,
        artifact_id: item.artifact.artifact_id,
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: null,
        accepted_view_text: null,
        accepted_view_complete: false,
      });
      checks.push(
        gapCheck(
          `accepted-view:${item.key}`,
          "artifact_integrity",
          `${item.key} current accepted view could not be read.`,
          currentVersionId
            ? {
                code: "accepted_view_unreadable",
                deliverable_key: item.key,
                document_id: document.id as string,
                version_id: currentVersionId,
              }
            : {
                code: "artifact_unavailable",
                deliverable_key: item.key,
                artifact_id: item.artifact.artifact_id,
              },
        ),
      );
      continue;
    }
    const projectedCharacters = Math.min(
      acceptedView.length,
      MAX_VERIFIER_DELIVERABLE_PROJECTION_CHARS,
      remainingProjectionCharacters,
    );
    const projectionComplete = projectedCharacters === acceptedView.length;
    const acceptedViewProjection = projectionComplete
      ? acceptedView
      : projectedCharacters === 0
        ? null
        : [
            acceptedView.slice(0, Math.floor(projectedCharacters / 2)),
            "\n[INCOMPLETE VERIFICATION PROJECTION — MIDDLE OMITTED]\n",
            acceptedView.slice(
              acceptedView.length - Math.ceil(projectedCharacters / 2),
            ),
          ].join("");
    remainingProjectionCharacters = Math.max(
      0,
      remainingProjectionCharacters - projectedCharacters,
    );
    deliverables.push({
      key: item.key,
      artifact_type: artifactType,
      artifact_id: item.artifact.artifact_id,
      document_id: document.id as string,
      current_version_id: currentVersionId,
      accepted_view_sha256: acceptedViewSha256(acceptedView),
      accepted_view_text: acceptedViewProjection,
      accepted_view_complete: projectionComplete,
    });
    checks.push(
      passCheck(
        `current-artifact:${item.key}`,
        "artifact_integrity",
        `${item.key} is the readable current Version in the fixed Matter.`,
      ),
    );
    if (!projectionComplete) {
      checks.push(
        gapCheck(
          `verification-scope:${item.key}`,
          "goal_coverage",
          `${item.key} exceeds the bounded semantic verification projection and requires lawyer review of the complete current Version.`,
          {
            code: "verification_scope_exceeded",
            deliverable_key: item.key,
            accepted_view_characters: acceptedView.length,
            projected_characters: projectedCharacters,
          },
        ),
      );
    }
  }

  const incomplete = input.snapshot.task.current_plan
    .slice(0, -1)
    .flatMap((step, position) =>
      step.status === "completed" ? [] : [position],
    );
  checks.push(
    incomplete.length
      ? gapCheck(
          "prior-steps-complete",
          "workflow_completion",
          "One or more prior Steps are incomplete.",
          { code: "prior_step_incomplete", step_positions: incomplete },
        )
      : passCheck(
          "prior-steps-complete",
          "workflow_completion",
          "Every prior Step is complete.",
        ),
  );

  if (input.citationsRequired) {
    if (input.citationCoverage.total === 0) {
      checks.push(
        gapCheck(
          "citation-relocation",
          "source_support",
          "No current citation snapshot is available for relocation.",
          { code: "citation_snapshot_missing", deliverable_key: null },
        ),
      );
    } else if (input.citationCoverage.missing > 0) {
      checks.push(
        gapCheck(
          "citation-relocation",
          "source_support",
          `${input.citationCoverage.missing} citation locator(s) are not exact on their pinned current source Version.`,
          {
            code: "citation_relocation_gap",
            deliverable_key: null,
            total: input.citationCoverage.total,
            missing: input.citationCoverage.missing,
            statuses: Array.from(
              { length: input.citationCoverage.missing },
              () => "missing" as const,
            ),
          },
        ),
      );
    } else {
      checks.push(
        passCheck(
          "citation-relocation",
          "source_support",
          "Every current citation relocates exactly on its pinned source Version.",
        ),
      );
    }
  }

  const context = readFixedMatterContext(input.snapshot.task);
  return buildAgentVerificationPacketV1({
    kind: "agent_verification_packet_v1",
    version: 1,
    task_id: input.snapshot.task.id,
    step_id: input.stepId,
    step_attempt: input.stepAttempt,
    matter_id: input.snapshot.task.matter_id,
    goal: input.snapshot.task.goal,
    profile: input.profile,
    deliverables,
    source_versions: (context?.sources ?? []).map((source) => ({
      document_id: source.document_id,
      version_id: source.version_id,
      role: source.role,
    })),
    deterministic_checks: checks,
  });
}
