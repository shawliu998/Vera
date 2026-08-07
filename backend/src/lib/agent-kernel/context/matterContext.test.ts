import assert from "node:assert/strict";
import test from "node:test";
import { planAgentTask } from "../../agentTaskPlanner";

import {
  assertMatterContextRowsMatchManifest,
  buildMatterContextManifest,
  MatterContextInvalidError,
  mergeImmutableAgentTaskCheckpoint,
  readFixedMatterContext,
} from "./matterContext";

function manifest() {
  return buildMatterContextManifest({
    matterId: "matter-1",
    compiledAt: "2026-08-07T00:00:00.000Z",
    sources: [
      {
        document_id: "document-1",
        version_id: "version-1",
        filename: "agreement.docx",
        file_type: "docx",
        role: "source",
      },
    ],
    workflow: {
      id: "workflow-1",
      title: "Contract review",
      description: "Review a fixed agreement.",
      type: "assistant",
      instructions: "Read the agreement and produce a source-linked memo.",
      columns: [],
    },
  });
}

const documents = [
  {
    id: "document-1",
    project_id: "matter-1",
    current_version_id: "version-1",
    status: "ready",
  },
];
const versions = [
  {
    id: "version-1",
    document_id: "document-1",
    filename: "agreement.docx",
    file_type: "docx",
    storage_path: "matter-1/agreement.docx",
    deleted_at: null,
  },
];

test("fixed Matter context preserves exact sources and Workflow snapshot", () => {
  const fixed = manifest();
  assert.equal(fixed.sources[0]?.version_id, "version-1");
  assert.equal(
    fixed.workflow?.instructions,
    "Read the agreement and produce a source-linked memo.",
  );
  assert.deepEqual(
    readFixedMatterContext({
      latest_checkpoint: { fixed_matter_context: fixed },
    }),
    fixed,
  );
});

test("fixed Matter context rejects duplicate sources and malformed persisted receipts", () => {
  assert.throws(
    () =>
      buildMatterContextManifest({
        matterId: "matter-1",
        sources: [manifest().sources[0]!, manifest().sources[0]!],
      }),
    /document ids must be unique/,
  );
  assert.throws(
    () =>
      readFixedMatterContext({
        latest_checkpoint: {
          fixed_matter_context: { ...manifest(), sources: [{}] },
        },
      }),
    MatterContextInvalidError,
  );
});

test("preflight rejects cross-Matter, changed, deleted and mismatched Versions", () => {
  assert.doesNotThrow(() =>
    assertMatterContextRowsMatchManifest(manifest(), documents, versions),
  );

  for (const [changedDocuments, changedVersions] of [
    [[{ ...documents[0]!, project_id: "matter-2" }], versions],
    [[{ ...documents[0]!, current_version_id: "version-2" }], versions],
    [documents, [{ ...versions[0]!, deleted_at: "2026-08-07T01:00:00.000Z" }]],
    [documents, [{ ...versions[0]!, document_id: "document-2" }]],
  ] as const) {
    assert.throws(
      () =>
        assertMatterContextRowsMatchManifest(
          manifest(),
          [...changedDocuments],
          [...changedVersions],
        ),
      MatterContextInvalidError,
    );
  }
});

test("progress checkpoint replacement retains assignment and durable execution receipts", () => {
  const fixed = manifest();
  assert.deepEqual(
    mergeImmutableAgentTaskCheckpoint(
      {
        fixed_matter_context: fixed,
        schema_version: "agent_task_checkpoint_v1",
        contract: { goal_spec: { kind: "agent_goal_v1" } },
        assignment_revisions: [
          { kind: "agent_assignment_context_revision_v1" },
        ],
        resolved_required_input_ids: ["required-input-1"],
        step_receipts: [{ kind: "agent_step_receipt_v1" }],
        runner_retry: { attempt: 2 },
        user_input: { message: "transient" },
      },
      { step_id: "step-2", iteration: 1, summary: "Done" },
    ),
    {
      fixed_matter_context: fixed,
      schema_version: "agent_task_checkpoint_v1",
      contract: { goal_spec: { kind: "agent_goal_v1" } },
      assignment_revisions: [{ kind: "agent_assignment_context_revision_v1" }],
      resolved_required_input_ids: ["required-input-1"],
      step_receipts: [{ kind: "agent_step_receipt_v1" }],
      step_id: "step-2",
      iteration: 1,
      summary: "Done",
    },
  );
});

test("source Version drift stops before the planner provider is called", async () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    documents: [
      {
        id: "document-1",
        project_id: "matter-1",
        current_version_id: "version-2",
        status: "ready",
      },
    ],
    document_versions: [
      {
        id: "version-2",
        document_id: "document-1",
        filename: "agreement-v2.docx",
        file_type: "docx",
        storage_path: "matter/agreement-v2.docx",
        deleted_at: null,
      },
    ],
  };
  const db = {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const query: Record<string, (...args: any[]) => any> = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        then(
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown,
        ) {
          return Promise.resolve({
            data: (tables[table] ?? []).filter((row) =>
              filters.every((filter) => filter(row)),
            ),
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  let providerCalled = false;
  await assert.rejects(
    planAgentTask({
      db: db as never,
      userId: "user-1",
      matterId: "matter-1",
      goal: "Review the agreement.",
      model: "deepseek-chat",
      request: { document_ids: ["document-1"] },
      contextManifest: manifest(),
      complete: async () => {
        providerCalled = true;
        return "{}";
      },
    }),
    MatterContextInvalidError,
  );
  assert.equal(providerCalled, false);
});
