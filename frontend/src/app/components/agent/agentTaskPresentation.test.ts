import assert from "node:assert/strict";
import test from "node:test";

import type { Document } from "@/app/components/shared/types";
import type { AgentTaskSnapshot } from "@/app/types/agent";
import {
  agentTaskWorkTitle,
  buildAgentTaskOutputRows,
  canRecoverAgentTaskExecution,
  getAgentTaskProviderPause,
  getAgentTaskSourceDocuments,
  getAgentTaskStepArtifacts,
  latestApprovedArtifact,
} from "./agentTaskPresentation";

function snapshotFixture(): AgentTaskSnapshot {
  return {
    task: {
      id: "task",
      matter_id: "matter",
      goal: "Review agreement",
      mode: "work",
      status: "completed",
      execution_model: "model",
      deliverables: [
        {
          key: "review-memo",
          title: "Review memo",
          required: true,
          artifact_type: "draft",
          artifact_id: "memo-current",
        },
        {
          key: "optional",
          title: "Optional note",
          required: false,
        },
      ],
      current_plan: [
        {
          id: "step-1",
          task_id: "task",
          title: "Draft review memo",
          status: "completed",
          expected_output: "Review memo draft",
          attempt: 1,
          result_summary: "Done",
        },
      ],
      current_step: null,
      latest_checkpoint: null,
      created_at: "now",
      updated_at: "now",
    },
    artifacts: [
      {
        task_id: "task",
        artifact_type: "document",
        artifact_id: "source",
        purpose: "Source document",
      },
      {
        task_id: "task",
        artifact_type: "draft",
        artifact_id: "memo-old",
        purpose: "Review memo draft",
      },
      {
        task_id: "task",
        artifact_type: "draft",
        artifact_id: "memo-current",
        purpose: "Review memo draft",
      },
      {
        task_id: "task",
        artifact_type: "citation_snapshot",
        artifact_id: "evidence-old",
        purpose: "Step 1 evidence citations",
      },
      {
        task_id: "task",
        artifact_type: "citation_snapshot",
        artifact_id: "evidence-current",
        purpose: "Step 1 evidence citations",
      },
    ],
    execution_recovery: { allowed: true, issue_code: null, detail: null },
    review: {
      status: "approved",
      decisions: [
        {
          id: "decision",
          task_id: "task",
          status: "approved",
          reviewer_id: null,
          reviewer_email: null,
          reviewer_name: null,
          note: "",
          created_at: "now",
          artifact_snapshot: [
            {
              artifact_type: "draft",
              artifact_id: "memo-current",
              purpose: "Review memo draft",
              document_id: "memo-current",
              version_id: "version-2",
              version_number: 2,
              filename: "memo.docx",
              file_type: "docx",
              size_bytes: 10,
              sha256: "hash",
            },
          ],
        },
      ],
      version_state: {
        latest_approved_decision_id: "decision",
        latest_approved_at: "now",
        has_previous_approval: true,
        has_unapproved_changes: false,
        current_artifacts: [
          {
            artifact_type: "draft",
            artifact_id: "memo-current",
            purpose: "Review memo draft",
            current_version_id: "version-2",
            current_version_number: 2,
            current_filename: "memo.docx",
            current_file_type: "docx",
            current_version_available: true,
            approved_version_id: "version-2",
            approved_version_number: 2,
            edited_after_approval: false,
            review_current_required: false,
          },
        ],
      },
    },
  };
}

test("does not offer execution recovery for an invalid fixed contract", () => {
  const snapshot = snapshotFixture();
  snapshot.execution_recovery = {
    allowed: false,
    issue_code: "capability_grant_invalid",
    detail: "Existing work is preserved. Start a new Work Task.",
  };
  assert.equal(canRecoverAgentTaskExecution(snapshot), false);
});

test("binds a required deliverable to its explicit artifact and current version", () => {
  const snapshot = snapshotFixture();
  const rows = buildAgentTaskOutputRows(snapshot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].linkedArtifact?.artifact_id, "memo-current");
  assert.equal(rows[0].currentVersion?.current_version_id, "version-2");
  assert.equal(rows[0].approvedArtifact?.version_id, "version-2");
  assert.equal(
    latestApprovedArtifact(snapshot, "memo-current")?.version_id,
    "version-2",
  );
});

test("keeps only the latest evidence snapshot and related deliverable for a step", () => {
  const snapshot = snapshotFixture();
  assert.deepEqual(
    getAgentTaskStepArtifacts(snapshot, snapshot.task.current_plan[0], 0).map(
      (artifact) => artifact.artifact_id,
    ),
    ["memo-old", "memo-current", "evidence-current"],
  );
});

test("selects source documents only through Task Artifact links", () => {
  const snapshot = snapshotFixture();
  const base = {
    project_id: "matter",
    file_type: "docx",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 1,
    page_count: 1,
    structure_tree: null,
    status: "ready" as const,
    created_at: "now",
  };
  const documents: Document[] = [
    { ...base, id: "source", filename: "source.docx" },
    { ...base, id: "unlinked", filename: "other.docx" },
  ];
  assert.deepEqual(
    getAgentTaskSourceDocuments(snapshot, documents).map(
      (document) => document.id,
    ),
    ["source"],
  );
});

test("presents a paused running step as paused and reads its structured provider issue", () => {
  const snapshot = snapshotFixture();
  snapshot.task.status = "paused";
  snapshot.task.current_plan[0].status = "running";
  snapshot.task.latest_checkpoint = {
    step_id: "step-1",
    iteration: 1,
    summary: "Existing progress was preserved.",
    created_at: "2026-08-08T00:00:00.000Z",
    execution_pause: {
      kind: "agent_task_execution_pause_v1",
      classification: "provider_configuration",
      issue: {
        kind: "agent_execution_issue_v1",
        code: "provider_configuration_required",
        category: "provider",
        recoverable: true,
      },
    },
    source_acquisition: {
      spec: { connector_id: "patent.epo-ops.publications" },
    },
  };

  assert.equal(agentTaskWorkTitle(snapshot), "Paused · Draft review memo");
  assert.deepEqual(getAgentTaskProviderPause(snapshot.task.latest_checkpoint), {
    classification: "provider_configuration",
    issueCode: "provider_configuration_required",
    connectorId: "patent.epo-ops.publications",
  });
});

test("does not derive provider actions from malformed structured pause data", () => {
  const snapshot = snapshotFixture();
  snapshot.task.latest_checkpoint = {
    step_id: "step-1",
    iteration: 1,
    summary: "Compatibility text must not authorize settings changes.",
    created_at: "2026-08-08T00:00:00.000Z",
    execution_pause: {
      kind: "agent_task_execution_pause_v1",
      classification: "provider_configuration",
      issue: {},
    },
  };

  assert.equal(getAgentTaskProviderPause(snapshot.task.latest_checkpoint), null);
});
