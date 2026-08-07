import assert from "node:assert/strict";
import test from "node:test";

import { advanceAgentTaskExecution } from "../../agentTaskExecution";
import {
  normalizeAgentTaskArtifactContracts,
  readAgentTaskAssignmentContract,
} from "./taskContract";

const goal = "Review the synthetic agreement and prepare a source-linked memo.";

function markedTask() {
  return {
    id: "task-contract",
    user_id: "user-fixture",
    matter_id: "matter-fixture",
    goal,
    mode: "work",
    status: "queued",
    execution_model: "deepseek-chat",
    deliverables: [
      {
        schema_version: "artifact_contract_v1",
        key: "review-memo",
        title: "Review memo",
        description: "Synthetic source-linked review memo.",
        required: true,
        artifact_type: "draft",
        purpose: "Review memo draft",
        kind: "document",
        format: "docx",
        operation: "create",
      },
    ],
    current_step: null,
    latest_checkpoint: {
      schema_version: "agent_task_checkpoint_v1",
      contract: {
        goal_spec: {
          kind: "agent_goal_v1",
          objective: goal,
          task_family: "contract_review",
          jurisdictions: [],
          as_of_date: null,
          deliverable_keys: ["review-memo"],
          completion_checks: [
            "deliverables_present",
            "goal_covered",
            "source_supported",
            "citations_relocatable",
            "steps_complete",
          ],
          source_standard: {
            material_claims_require_citations: true,
            authority_required: false,
            authority_as_of_required: false,
          },
          must_ask_when: [
            "missing_source",
            "missing_fact",
            "evidence_conflict",
            "legal_judgment",
            "source_version_changed",
            "material_scope_change",
            "consequential_action",
          ],
        },
        context_manifest: {
          kind: "matter_context_v1",
          matter_id: "matter-fixture",
          sources: [
            {
              document_id: "document-fixture",
              version_id: "version-fixture",
              filename: "synthetic-agreement.docx",
              file_type: "docx",
              role: "source",
            },
          ],
          workflow: null,
          compiled_at: "2026-08-07T00:00:00.000Z",
        },
      },
    },
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
  };
}

test("normalizes legacy deliverables into fixed document ArtifactContracts", () => {
  const contracts = normalizeAgentTaskArtifactContracts([
    {
      key: "risk-matrix",
      title: "Risk matrix",
      description: "Synthetic clause findings and sources.",
      required: true,
      artifact_type: "tabular_review",
      purpose: "Risk matrix",
    },
    {
      key: "review-memo",
      title: "Review memo",
      description: "Synthetic source-linked review memo.",
      required: false,
      artifact_type: "draft",
      purpose: "Review memo draft",
    },
  ]);
  assert.deepEqual(
    contracts.map(({ schema_version, kind, format, operation }) => ({
      schema_version,
      kind,
      format,
      operation,
    })),
    [
      {
        schema_version: "artifact_contract_v1",
        kind: "document",
        format: "xlsx",
        operation: "create",
      },
      {
        schema_version: "artifact_contract_v1",
        kind: "document",
        format: "docx",
        operation: "create",
      },
    ],
  );
});

test("distinguishes legacy, valid and marked invalid assignment contracts", () => {
  assert.deepEqual(readAgentTaskAssignmentContract({ deliverables: [] }), {
    state: "legacy",
  });
  assert.equal(readAgentTaskAssignmentContract(markedTask()).state, "valid");

  const invalidSource = structuredClone(markedTask());
  invalidSource.latest_checkpoint.contract.context_manifest.sources[0]!.version_id =
    "";
  assert.equal(
    readAgentTaskAssignmentContract(invalidSource).state,
    "invalid",
  );

  const invalidArtifact = structuredClone(markedTask());
  invalidArtifact.deliverables[0]!.format = "xlsx";
  assert.equal(
    readAgentTaskAssignmentContract(invalidArtifact).state,
    "invalid",
  );

  const wrongMatter = structuredClone(markedTask());
  wrongMatter.latest_checkpoint.contract.context_manifest.matter_id =
    "another-matter";
  assert.equal(readAgentTaskAssignmentContract(wrongMatter).state, "invalid");
});

test("invalid marked contracts stop before model planning or writes", async () => {
  const task = markedTask();
  task.latest_checkpoint.contract.context_manifest.sources[0]!.version_id = "";
  const rows: Record<string, Array<Record<string, unknown>>> = {
    agent_tasks: [task],
    agent_steps: [],
    agent_artifact_links: [],
    agent_task_review_decisions: [],
  };
  const reads: string[] = [];
  const writes: string[] = [];
  const db = {
    from(table: string) {
      reads.push(table);
      if (!Object.hasOwn(rows, table)) {
        throw new Error(`Unexpected live query: ${table}`);
      }
      const filters: Array<[string, unknown]> = [];
      const selected = () =>
        rows[table]!.filter((row) =>
          filters.every(([column, value]) => row[column] === value),
        );
      const query: Record<string, (...args: any[]) => any> = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        order: () => query,
        update: () => {
          writes.push(`update:${table}`);
          return query;
        },
        insert: () => {
          writes.push(`insert:${table}`);
          return query;
        },
        delete: () => {
          writes.push(`delete:${table}`);
          return query;
        },
        maybeSingle: () =>
          Promise.resolve({ data: selected()[0] ?? null, error: null }),
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve({ data: selected(), error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return query;
    },
  };

  await assert.rejects(
    advanceAgentTaskExecution({
      db: db as never,
      taskId: task.id,
      userId: task.user_id,
    }),
    /Assignment Contract is invalid/,
  );
  assert.deepEqual(
    new Set(reads),
    new Set([
      "agent_tasks",
      "agent_steps",
      "agent_artifact_links",
      "agent_task_review_decisions",
    ]),
  );
  assert.deepEqual(writes, []);
});
