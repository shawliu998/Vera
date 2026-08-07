import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentStepEffectReservation } from "./agent-kernel/effects/stepEffect";
import { buildCurrentAgentVerificationPacket } from "./agentTaskVerificationRepository";

const taskId = "11111111-1111-4111-8111-111111111111";
const matterId = "22222222-2222-4222-8222-222222222222";
const currentVersion = "33333333-3333-4333-8333-333333333333";

function fakeDb(input: {
  documents: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
}) {
  return {
    from(table: string) {
      const rows = table === "documents" ? input.documents : input.versions;
      return {
        select() {
          return {
            async in(_column: string, ids: string[]) {
              return {
                data: rows.filter((row) => ids.includes(String(row.id))),
                error: null,
              };
            },
          };
        },
      };
    },
  };
}

function fixture() {
  const reserved = buildAgentStepEffectReservation({
    stepId: "step-create",
    attempt: 1,
    toolName: "generate_docx",
    toolInput: { title: "Opinion", sections: [] },
    createdAt: "2026-08-07T00:00:00.000Z",
  });
  const receipt = {
    ...reserved,
    status: "committed" as const,
    effect: {
      document_id: reserved.target.document_id,
      version_id: reserved.target.version_id,
      artifact_type: "draft" as const,
    },
    committed_at: "2026-08-07T00:01:00.000Z",
  };
  return {
    reserved,
    snapshot: {
      task: {
        id: taskId,
        matter_id: matterId,
        goal: "Draft an opinion.",
        deliverables: [
          {
            key: "opinion",
            title: "Opinion",
            required: true,
            artifact_type: "draft",
            purpose: "Opinion",
          },
        ],
        latest_checkpoint: null,
        current_plan: [
          {
            id: "step-create",
            status: "completed",
            attempt: 1,
            result_data: {
              effect_receipts: { [receipt.effect_key]: receipt },
            },
          },
          { id: "step-verify", status: "running", attempt: 1 },
        ],
      },
      artifacts: [
        {
          artifact_type: "draft" as const,
          artifact_id: reserved.target.document_id,
          purpose: "Opinion",
        },
      ],
    },
  };
}

const profile = {
  kind: "agent_verifier_profile_v1" as const,
  id: "generic-current-artifact",
  version: "1",
  semantic_goal_check: true,
  repair_policy: "none" as const,
};

test("builds a verifier packet from the fixed current accepted view", async () => {
  const { reserved, snapshot } = fixture();
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: reserved.target.version_id,
      },
    ],
    versions: [
      {
        id: reserved.target.version_id,
        document_id: reserved.target.document_id,
        storage_path: "fixed.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const packet = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: true,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => "Current accepted Word text.",
  });
  assert.equal(
    packet.deliverables[0].accepted_view_text,
    "Current accepted Word text.",
  );
  assert.match(packet.deliverables[0].accepted_view_sha256 ?? "", /^sha256:/);
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "current-artifact:opinion",
    )?.status,
    "pass",
  );
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "citation-relocation",
    )?.issue?.code,
    "citation_snapshot_missing",
  );
});

test("fixed effect Version drift stops before accepted-view loading", async () => {
  const { reserved, snapshot } = fixture();
  let loaded = false;
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: currentVersion,
      },
    ],
    versions: [
      {
        id: currentVersion,
        document_id: reserved.target.document_id,
        storage_path: "changed.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const packet = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => {
      loaded = true;
      return "Changed text";
    },
  });
  assert.equal(loaded, false);
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "artifact-version:opinion",
    )?.issue?.code,
    "artifact_version_changed",
  );
});

test("oversized accepted views become bounded review projections, not failures", async () => {
  const { reserved, snapshot } = fixture();
  const db = fakeDb({
    documents: [
      {
        id: reserved.target.document_id,
        user_id: "user-1",
        project_id: matterId,
        current_version_id: reserved.target.version_id,
      },
    ],
    versions: [
      {
        id: reserved.target.version_id,
        document_id: reserved.target.document_id,
        storage_path: "long.docx",
        file_type: "docx",
        deleted_at: null,
      },
    ],
  });
  const packet = await buildCurrentAgentVerificationPacket({
    db: db as never,
    snapshot,
    userId: "user-1",
    stepId: "step-verify",
    stepAttempt: 1,
    profile,
    citationsRequired: false,
    citationCoverage: { total: 0, relocatable: 0, missing: 0 },
    loadAcceptedView: async () => "长".repeat(120_000),
  });
  assert.equal(packet.deliverables[0].accepted_view_complete, false);
  assert.match(
    packet.deliverables[0].accepted_view_text ?? "",
    /INCOMPLETE VERIFICATION PROJECTION/,
  );
  assert.equal(
    packet.deterministic_checks.find(
      (check) => check.code === "verification-scope:opinion",
    )?.issue?.code,
    "verification_scope_exceeded",
  );
});
