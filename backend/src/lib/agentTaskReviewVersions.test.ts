import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentReviewVersionState,
  controlledAgentReviewArtifactLinks,
  getAgentReviewVersionState,
} from "./agentTaskReviewVersions";

const reviewId = "11111111-1111-4111-8111-111111111111";

function links() {
  return controlledAgentReviewArtifactLinks({
    task: {
      id: "task-1",
      user_id: "user-1",
      matter_id: "matter-1",
      status: "completed",
      deliverables: [
        {
          key: "inventory",
          artifact_type: "tabular_review",
          purpose: "Evidence inventory",
          required: true,
        },
      ],
    },
    artifacts: [
      {
        artifact_type: "tabular_review",
        artifact_id: reviewId,
        purpose: "Evidence inventory",
      },
    ],
  });
}

function approvedSnapshot() {
  return [
    {
      kind: "agent_approved_tabular_artifact_v1",
      artifact_type: "tabular_review",
      artifact_id: reviewId,
      purpose: "Evidence inventory",
      review_id: reviewId,
      row_protocol: "document_rows",
      input_digest: "a".repeat(64),
      revision_fingerprint: "b".repeat(64),
      accepted_view_sha256: `sha256:${"c".repeat(64)}`,
      source_receipt_fingerprint: null,
      decision_fingerprint: null,
      completion_sha256: null,
      export_document_id: "22222222-2222-4222-8222-222222222222",
      export_version_id: "33333333-3333-4333-8333-333333333333",
      version_number: 1,
      filename: "Evidence inventory.xlsx",
      file_type: "xlsx",
      size_bytes: 10,
      sha256: `sha256:${"d".repeat(64)}`,
    },
  ];
}

test("Tabular review state compares the live revision, not a Review UUID as a Document", () => {
  const latest = {
    id: "decision-1",
    created_at: "2026-08-08T00:00:00.000Z",
    artifact_snapshot: approvedSnapshot(),
  };
  const current = buildAgentReviewVersionState(
    links(),
    [],
    [],
    latest,
    [{ id: reviewId }],
    new Map([[reviewId, "b".repeat(64)]]),
  );
  assert.equal(current.current_artifacts[0]?.review_current_required, false);
  assert.equal(
    current.current_artifacts[0]?.approved_revision_fingerprint,
    "b".repeat(64),
  );

  const changed = buildAgentReviewVersionState(
    links(),
    [],
    [],
    latest,
    [{ id: reviewId }],
    new Map([[reviewId, "e".repeat(64)]]),
  );
  assert.equal(changed.current_artifacts[0]?.edited_after_approval, true);
  assert.equal(changed.current_artifacts[0]?.review_current_required, true);
});

test("legacy seven-field Tabular approval is readable but always requires current review", () => {
  const state = buildAgentReviewVersionState(
    links(),
    [],
    [],
    {
      id: "decision-1",
      created_at: "2026-08-08T00:00:00.000Z",
      artifact_snapshot: [
        {
          artifact_type: "tabular_review",
          artifact_id: reviewId,
          purpose: "Evidence inventory",
          review_id: reviewId,
          row_protocol: "document_rows",
          input_digest: "a".repeat(64),
          revision_fingerprint: "b".repeat(64),
        },
      ],
    },
    [{ id: reviewId }],
    new Map([[reviewId, "b".repeat(64)]]),
  );
  assert.equal(state.current_artifacts[0]?.approved_snapshot_state, "legacy_tabular");
  assert.equal(state.current_artifacts[0]?.review_current_required, true);
});

test("missing, invalid, or wrong-type approved entries cannot preserve approval", () => {
  const latest = (artifact_snapshot: unknown[]) => ({
    id: "decision-1",
    created_at: "2026-08-08T00:00:00.000Z",
    artifact_snapshot,
  });
  for (const snapshot of [
    [],
    [{ malformed: true }],
    [...approvedSnapshot(), { malformed: true }],
    [...approvedSnapshot(), ...approvedSnapshot()],
    [
      {
        artifact_type: "draft",
        artifact_id: reviewId,
        purpose: "Wrong type",
        document_id: reviewId,
        version_id: "22222222-2222-4222-8222-222222222222",
        version_number: 1,
        filename: "wrong.docx",
        file_type: "docx",
        size_bytes: 1,
        sha256: `sha256:${"a".repeat(64)}`,
      },
    ],
  ]) {
    const state = buildAgentReviewVersionState(
      links(),
      [],
      [],
      latest(snapshot),
      [{ id: reviewId }],
      new Map([[reviewId, "b".repeat(64)]]),
    );
    assert.equal(state.current_artifacts[0]?.approved_snapshot_state, "invalid");
    assert.equal(state.current_artifacts[0]?.review_current_required, true);
  }
});

test("Tabular availability rejects a Review outside the Task owner or Matter", async () => {
  const db = {
    from(table: string) {
      return {
        select() {
          return {
            in: async () => ({
              data:
                table === "tabular_reviews"
                  ? [
                      {
                        id: reviewId,
                        project_id: "different-matter",
                        user_id: "different-user",
                        row_protocol: "document_rows",
                      },
                    ]
                  : [],
              error: null,
            }),
          };
        },
      };
    },
    rpc: async () => ({
      data: { outcome: "current", revision_fingerprint: "b".repeat(64) },
      error: null,
    }),
  };
  const state = await getAgentReviewVersionState(db as never, {
    task: {
      id: "task-1",
      user_id: "user-1",
      matter_id: "matter-1",
      status: "completed",
      deliverables: [
        {
          key: "inventory",
          artifact_type: "tabular_review",
          purpose: "Evidence inventory",
          required: true,
        },
      ],
    },
    artifacts: [
      {
        artifact_type: "tabular_review",
        artifact_id: reviewId,
        purpose: "Evidence inventory",
      },
    ],
    review: {
      decisions: [
        {
          id: "decision-1",
          status: "approved",
          created_at: "2026-08-08T00:00:00.000Z",
          artifact_snapshot: approvedSnapshot(),
        },
      ],
    },
  });
  assert.equal(state.current_artifacts[0]?.current_version_available, false);
  assert.equal(state.current_artifacts[0]?.review_current_required, true);
});

test("Draft availability binds its Document query to the Task owner and Matter", async () => {
  const draftId = "44444444-4444-4444-8444-444444444444";
  const versionId = "55555555-5555-4555-8555-555555555555";
  const documentFilters: Array<[string, unknown]> = [];
  const db = {
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        in() {
          return query;
        },
        eq(column: string, value: unknown) {
          if (table === "documents") documentFilters.push([column, value]);
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "documents"
              ? [{ id: draftId, current_version_id: versionId }]
              : table === "document_versions"
                ? [
                    {
                      id: versionId,
                      document_id: draftId,
                      version_number: 1,
                      filename: "Opinion.docx",
                      file_type: "docx",
                      deleted_at: null,
                    },
                  ]
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const state = await getAgentReviewVersionState(db as never, {
    task: {
      id: "task-1",
      user_id: "user-1",
      matter_id: "matter-1",
      status: "completed",
      deliverables: [
        {
          key: "opinion",
          artifact_type: "draft",
          purpose: "Evidence opinion",
          required: true,
        },
      ],
    },
    artifacts: [
      {
        artifact_type: "draft",
        artifact_id: draftId,
        purpose: "Evidence opinion",
      },
    ],
  });
  assert.deepEqual(documentFilters, [
    ["user_id", "user-1"],
    ["project_id", "matter-1"],
  ]);
  assert.equal(state.current_artifacts[0]?.current_version_available, true);
});

test("version-state repository does not query documents with a Tabular Review id", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./agentTaskReviewVersions.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /draftDocumentIds/);
  assert.match(source, /from\("tabular_reviews"\)/);
  assert.doesNotMatch(source, /links\.map\(\(artifact\) => artifact\.artifact_id\)/);
});
