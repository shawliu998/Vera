import assert from "node:assert/strict";
import test from "node:test";

import { buildMatterContextManifest } from "./agent-kernel/context/matterContext";
import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import { compileCompletedAgentSourceContext } from "./agentSourceAcquisitionContext";
import { PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION } from "./providerSourceAcquisition";
import { providerSourceAcquisitionStateSchema } from "./providerSourceAcquisitionState";

const MATTER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const IMPORT_DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const IMPORT_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-08T10:00:00.000Z";

const previousContext = buildMatterContextManifest({
  matterId: MATTER_ID,
  compiledAt: NOW,
  sources: [
    {
      document_id: TARGET_DOCUMENT_ID,
      version_id: TARGET_VERSION_ID,
      filename: "target-claim.docx",
      file_type: "docx",
      role: "source",
    },
  ],
});

const discovery = {
  schema_version: "read_only_source_discovery_v1" as const,
  discovery_ref: "epo-ops:publication:US7654321A1",
  provider_id: "epo-ops",
  external_id: "publication:US7654321A1",
  source_kind: "patent_publication",
  title: "Sensor publication",
  canonical_url:
    "https://worldwide.espacenet.com/patent/search?q=pn%3DUS7654321A1",
  published_on: "2025-01-01",
  not_citable: true as const,
  metadata: {},
};

const completedState = providerSourceAcquisitionStateSchema.parse({
  schema_version: "provider_source_acquisition_state_v1",
  spec: {
    schema_version: PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
    connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    query: "ti=sensor",
    jurisdiction: "US",
    as_of_date: "2026-08-08",
    maximum_pages: 1,
    page_size: 10,
    maximum_selections: 1,
  },
  phase: "completed",
  next_page: null,
  discoveries: [discovery],
  selected_discovery_refs: [discovery.discovery_ref],
  search_receipts: [],
  search_coverage: [],
  read_receipts: [],
  import_receipts: [
    {
      schema_version: "provider_source_import_receipt_v1",
      provider_id: discovery.provider_id,
      external_id: discovery.external_id,
      snapshot_ref: discovery.discovery_ref,
      content_sha256: `sha256:${"a".repeat(64)}`,
      document_id: IMPORT_DOCUMENT_ID,
      version_id: IMPORT_VERSION_ID,
      version_number: 1,
      filename: "US7654321A1.json",
      created: true,
      current_version_id: IMPORT_VERSION_ID,
    },
  ],
  issues: [],
});

function checkpoint() {
  return {
    schema_version: "agent_task_checkpoint_v1",
    contract: { context_manifest: previousContext },
    fixed_matter_context: previousContext,
    source_selection: {
      schema_version: "provider_source_selection_v1",
      submission_id: "selection-1",
      selected_discovery_refs: [discovery.discovery_ref],
      submitted_at: NOW,
    },
    source_acquisition: completedState,
  };
}

test("completed lawyer-selected imports extend one fixed Task context without replacing prior sources", async () => {
  const extendedContext = buildMatterContextManifest({
    matterId: MATTER_ID,
    compiledAt: "2026-08-08T10:01:00.000Z",
    sources: [
      ...previousContext.sources,
      {
        document_id: IMPORT_DOCUMENT_ID,
        version_id: IMPORT_VERSION_ID,
        filename: "US7654321A1.json",
        file_type: "json",
        role: "source",
      },
    ],
  });
  const result = await compileCompletedAgentSourceContext({
    db: {} as never,
    previousCheckpoint: checkpoint(),
    previousContext,
    acquisitionState: completedState,
    dependencies: {
      extendContext: async (_db, context, documentIds) => {
        assert.deepEqual(context, previousContext);
        assert.deepEqual(documentIds, [IMPORT_DOCUMENT_ID]);
        return extendedContext;
      },
    },
  });
  assert.deepEqual(result.sourceDocumentIds, [IMPORT_DOCUMENT_ID]);
  assert.deepEqual(
    result.checkpointValues.fixed_matter_context,
    extendedContext,
  );
  assert.deepEqual(
    (result.checkpointValues.contract as { context_manifest: unknown })
      .context_manifest,
    extendedContext,
  );
  assert.deepEqual(result.checkpointValues.assignment_revisions, [
    {
      kind: "agent_assignment_context_revision_v1",
      reason: "source_acquisition",
      request_id: "selection-1",
      previous_compiled_at: previousContext.compiled_at,
      next_compiled_at: extendedContext.compiled_at,
      added_document_ids: [IMPORT_DOCUMENT_ID],
      created_at: (
        result.checkpointValues.assignment_revisions as Array<{
          created_at: string;
        }>
      )[0]?.created_at,
    },
  ]);
});

test("context extension fails closed without a completed state and exact selection receipt", async () => {
  await assert.rejects(
    compileCompletedAgentSourceContext({
      db: {} as never,
      previousCheckpoint: checkpoint(),
      previousContext,
      acquisitionState: { ...completedState, phase: "read_pending" },
    }),
    /Only completed/,
  );
  const missingSelection = checkpoint();
  delete (missingSelection as Partial<typeof missingSelection>)
    .source_selection;
  await assert.rejects(
    compileCompletedAgentSourceContext({
      db: {} as never,
      previousCheckpoint: missingSelection,
      previousContext,
      acquisitionState: completedState,
    }),
    /no exact lawyer selection receipt/,
  );
  const mismatchedSelection = checkpoint();
  mismatchedSelection.source_selection.selected_discovery_refs = [
    "epo-ops:publication:US0000000A1",
  ];
  await assert.rejects(
    compileCompletedAgentSourceContext({
      db: {} as never,
      previousCheckpoint: mismatchedSelection,
      previousContext,
      acquisitionState: completedState,
    }),
    /does not match the exact lawyer selection/,
  );
});
