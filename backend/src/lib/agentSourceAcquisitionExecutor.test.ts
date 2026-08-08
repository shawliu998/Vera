import assert from "node:assert/strict";
import test from "node:test";

import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import { resolveAgentStepCapabilityGrant } from "./agent-kernel/capability/stepCapability";
import { buildMatterContextManifest } from "./agent-kernel/context/matterContext";
import type { AgentStepContractV1 } from "./agent-kernel/contracts/stepContract";
import { executeAgentSourceAcquisitionStep } from "./agentSourceAcquisitionExecutor";
import { prepareAgentTaskSourceSelectionTransition } from "./agentTaskSourceSelection";
import {
  PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  compileProviderSourceSearchRequest,
} from "./providerSourceAcquisition";
import {
  appendProviderSourceSearchPage,
  createProviderSourceAcquisitionState,
  providerSourceAcquisitionStateSchema,
} from "./providerSourceAcquisitionState";

const NOW = "2026-08-08T10:00:00.000Z";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MATTER_ID = "22222222-2222-4222-8222-222222222222";
const STEP_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";

const contract = {
  schema_version: "agent_step_contract_v1",
  position: 0,
  capability: "read_sources",
  operation: "source.acquire",
  output_expectation: { kind: "checkpoint" },
  source_requirement: {
    mode: "authority",
    citations_required: true,
    authority_as_of_required: true,
    jurisdictions: ["US"],
    as_of_date: "2026-08-08",
  },
  deterministic_postconditions: ["summary_present", "source_versions_recorded"],
} satisfies AgentStepContractV1;

const grant = resolveAgentStepCapabilityGrant({
  contract,
  availableToolNames: [],
  readOnlyConnectorPins: [EPO_OPS_SOURCE_CONNECTOR_PIN],
});

const spec = {
  schema_version: PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
  query: "ti=sensor",
  jurisdiction: "US",
  as_of_date: "2026-08-08",
  maximum_pages: 1,
  page_size: 2,
  maximum_selections: 2,
};

const fixedContext = buildMatterContextManifest({
  matterId: MATTER_ID,
  compiledAt: NOW,
  sources: [
    {
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      filename: "invention-disclosure.docx",
      file_type: "docx",
      role: "source",
    },
  ],
});

function discovery(id = "US7654321A1") {
  return {
    schema_version: "read_only_source_discovery_v1" as const,
    discovery_ref: `epo-ops:publication:${id}`,
    provider_id: "epo-ops",
    external_id: `publication:${id}`,
    source_kind: "patent_publication",
    title: `Sensor publication ${id}`,
    canonical_url: `https://worldwide.espacenet.com/patent/search?q=pn%3D${id}`,
    published_on: "2025-01-01",
    not_citable: true as const,
    metadata: {},
  };
}

function receipt(input: {
  requestRef: string;
  operation: "search" | "read_snapshot";
  returnedDiscoveryRefs?: string[];
  returnedSnapshotRefs?: string[];
}) {
  return {
    schema_version: "read_only_source_receipt_v2" as const,
    task_id: "task-1",
    step_id: STEP_ID,
    step_position: 0,
    attempt: 1,
    matter_id: MATTER_ID,
    source_version_ids: [VERSION_ID],
    connector_pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization: {
      schema_version: "read_only_source_authorization_v1" as const,
      connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
      connection: "connected" as const,
      subscription: "not_required" as const,
      checked_at: NOW,
    },
    request_ref: input.requestRef,
    operation: input.operation,
    egress_fields_sent:
      input.operation === "search"
        ? ([
            "query",
            "jurisdiction",
            "as_of_date",
            "page",
            "page_size",
          ] as const)
        : (["jurisdiction", "as_of_date", "external_id"] as const),
    external_call_attempted: true,
    external_side_effect: "none" as const,
    status: "ok" as const,
    error_category: null,
    returned_discovery_refs: input.returnedDiscoveryRefs ?? [],
    returned_snapshot_refs: input.returnedSnapshotRefs ?? [],
    started_at: NOW,
    completed_at: NOW,
    idempotency_key: `source:${"a".repeat(64)}`,
  };
}

function coverage(requestRef: string) {
  return {
    schema_version: "read_only_source_coverage_v1" as const,
    request_ref: requestRef,
    status: "complete" as const,
    pages_examined: 1,
    items_examined: 1,
    truncated: false,
    gaps: [],
  };
}

function snapshot(state: unknown, attempt = 1) {
  return {
    snapshot: {
      task: {
        id: "task-1",
        matter_id: MATTER_ID,
        latest_checkpoint: {
          fixed_matter_context: fixedContext,
          source_acquisition: state,
        },
      },
    },
    step: { id: STEP_ID, attempt },
  };
}

function searchedState() {
  const initial = createProviderSourceAcquisitionState({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
  });
  const request = compileProviderSourceSearchRequest({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    requestRef: `${STEP_ID}:a1:search:1`,
    page: 1,
  });
  const found = discovery();
  return appendProviderSourceSearchPage({
    state: initial,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    request,
    outcome: {
      kind: "completed",
      operation: "search",
      discoveries: [found],
      coverage: coverage(request.request_ref),
      receipt: receipt({
        requestRef: request.request_ref,
        operation: "search",
        returnedDiscoveryRefs: [found.discovery_ref],
      }),
      imports: [],
    },
  });
}

test("server-owned acquisition searches fixed scope and stops for exact lawyer selection", async () => {
  const initial = createProviderSourceAcquisitionState({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
  });
  let callCount = 0;
  let recordedPhase: string | null = null;
  const result = await executeAgentSourceAcquisitionStep({
    db: {} as never,
    ...snapshot(initial),
    userId: USER_ID,
    contract,
    grant,
    now: () => NOW,
    dependencies: {
      executeAcquisition: async (input) => {
        callCount += 1;
        assert.equal(input.operation, "search");
        assert.equal(input.request.query, spec.query);
        assert.equal(input.request.page, 1);
        const found = discovery();
        return {
          kind: "completed",
          operation: "search",
          discoveries: [found],
          coverage: coverage(input.request.request_ref),
          receipt: receipt({
            requestRef: input.request.request_ref,
            operation: "search",
            returnedDiscoveryRefs: [found.discovery_ref],
          }),
          imports: [],
        };
      },
      recordProgress: async (state) => {
        recordedPhase = state.phase;
        return true;
      },
    },
  });
  assert.equal(callCount, 1);
  assert.equal(recordedPhase, "selection_required");
  assert.equal(result.kind, "execution");
  if (result.kind !== "execution") return;
  assert.equal(result.result.waitingForInput, true);
  assert.equal(
    providerSourceAcquisitionStateSchema.parse(
      result.result.checkpointValues?.source_acquisition,
    ).phase,
    "selection_required",
  );
});

test("lawyer selection resumes only selected reads and completes imported current Versions", async () => {
  const searched = searchedState();
  const selection = prepareAgentTaskSourceSelectionTransition(
    {
      task: {
        status: "waiting_input",
        current_plan: [
          { id: STEP_ID, status: "blocked", attempt: 1 },
          { id: "step-2", status: "pending", attempt: 0 },
          { id: "step-3", status: "pending", attempt: 0 },
        ],
        latest_checkpoint: {
          fixed_matter_context: fixedContext,
          contract: {
            step_contracts: {
              kind: "agent_step_contract_set_v1",
              steps: [
                contract,
                {
                  ...contract,
                  position: 1,
                  capability: "analyze",
                  operation: "classify",
                },
                {
                  ...contract,
                  position: 2,
                  capability: "verify",
                  operation: "verify",
                  output_expectation: { kind: "verification" },
                },
              ],
            },
            capability_grants: [
              grant,
              resolveAgentStepCapabilityGrant({
                contract: {
                  ...contract,
                  position: 1,
                  capability: "analyze",
                  operation: "classify",
                },
                availableToolNames: [],
              }),
              resolveAgentStepCapabilityGrant({
                contract: {
                  ...contract,
                  position: 2,
                  capability: "verify",
                  operation: "verify",
                  output_expectation: { kind: "verification" },
                },
                availableToolNames: [],
              }),
            ],
          },
          source_acquisition: searched,
        },
      },
    },
    [searched.discoveries[0]!.discovery_ref],
    NOW,
    "selection-1",
  );
  const selected = providerSourceAcquisitionStateSchema.parse(
    selection.checkpoint.source_acquisition,
  );
  assert.equal(selected.phase, "read_pending");
  assert.equal(selection.checkpoint.user_input.attempt, 2);
  assert.throws(
    () =>
      prepareAgentTaskSourceSelectionTransition(
        {
          task: {
            status: "waiting_input",
            current_plan: [
              { id: STEP_ID, status: "blocked", attempt: 1 },
              { id: "step-2", status: "pending", attempt: 0 },
              { id: "step-3", status: "pending", attempt: 0 },
            ],
            latest_checkpoint: {
              ...selection.checkpoint,
              source_acquisition: searched,
            },
          },
        },
        ["epo-ops:publication:forged"],
      ),
    /not a returned discovery/,
  );

  const result = await executeAgentSourceAcquisitionStep({
    db: {} as never,
    snapshot: {
      task: {
        id: "task-1",
        matter_id: MATTER_ID,
        latest_checkpoint: selection.checkpoint,
      },
    },
    step: { id: STEP_ID, attempt: 2 },
    userId: USER_ID,
    contract,
    grant,
    now: () => NOW,
    dependencies: {
      executeAcquisition: async (input) => {
        assert.equal(input.operation, "read_snapshot");
        assert.equal(input.request.external_id, discovery().external_id);
        const snapshotRef = discovery().discovery_ref;
        return {
          kind: "completed",
          operation: "read_snapshot",
          discoveries: [],
          coverage: coverage(input.request.request_ref),
          receipt: receipt({
            requestRef: input.request.request_ref,
            operation: "read_snapshot",
            returnedSnapshotRefs: [snapshotRef],
          }),
          imports: [
            {
              schema_version: "provider_source_import_receipt_v1",
              provider_id: discovery().provider_id,
              external_id: discovery().external_id,
              snapshot_ref: snapshotRef,
              content_sha256: `sha256:${"b".repeat(64)}`,
              document_id: "66666666-6666-4666-8666-666666666666",
              version_id: "77777777-7777-4777-8777-777777777777",
              version_number: 1,
              filename: "US7654321A1.json",
              created: true,
              current_version_id: "77777777-7777-4777-8777-777777777777",
            },
          ],
        };
      },
    },
  });
  assert.equal(result.kind, "execution");
  if (result.kind !== "execution") return;
  assert.equal(result.result.waitingForInput, false);
  assert.deepEqual(result.result.artifacts, [
    {
      artifact_type: "document",
      artifact_id: "66666666-6666-4666-8666-666666666666",
      purpose: "Source document",
    },
  ]);
  assert.equal(
    providerSourceAcquisitionStateSchema.parse(
      result.result.checkpointValues?.source_acquisition,
    ).phase,
    "completed",
  );
});

test("provider pauses preserve the exact resumable acquisition checkpoint", async () => {
  const initial = createProviderSourceAcquisitionState({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
  });
  const result = await executeAgentSourceAcquisitionStep({
    db: {} as never,
    ...snapshot(initial),
    userId: USER_ID,
    contract,
    grant,
    dependencies: {
      executeAcquisition: async () => ({
        kind: "provider_pause",
        classification: "provider_capacity",
        receipt: {} as never,
      }),
    },
  });
  assert.equal(result.kind, "provider_pause");
  if (result.kind !== "provider_pause") return;
  assert.equal(result.classification, "provider_capacity");
  assert.deepEqual(result.checkpointValues.source_acquisition, initial);
});

test("a lost execution lease stops after the completed provider call instead of advancing uncheckpointed state", async () => {
  const initial = createProviderSourceAcquisitionState({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
  });
  await assert.rejects(
    executeAgentSourceAcquisitionStep({
      db: {} as never,
      ...snapshot(initial),
      userId: USER_ID,
      contract,
      grant,
      dependencies: {
        executeAcquisition: async (input) => {
          const found = discovery();
          return {
            kind: "completed",
            operation: "search",
            discoveries: [found],
            coverage: coverage(input.request.request_ref),
            receipt: receipt({
              requestRef: input.request.request_ref,
              operation: "search",
              returnedDiscoveryRefs: [found.discovery_ref],
            }),
            imports: [],
          };
        },
        recordProgress: async () => false,
      },
    }),
    /paused or blocked/,
  );
});
