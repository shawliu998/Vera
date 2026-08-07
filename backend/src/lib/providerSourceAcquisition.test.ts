import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentStepCapabilityGrant } from "./agent-kernel/capability/stepCapability";
import { READ_ONLY_SOURCE_REQUEST_VERSION } from "./agent-kernel/connectors/readOnlySourceContract";
import type { AgentStepContractV1 } from "./agent-kernel/contracts/stepContract";
import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import {
  PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  compileProviderSourceSearchRequest,
  compileProviderSourceSelectedReadRequest,
  executeCurrentUserProviderSourceAcquisition,
  validateProviderSourceAcquisitionSpec,
} from "./providerSourceAcquisition";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MATTER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-08T10:00:00.000Z";

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
  deterministic_postconditions: [
    "summary_present",
    "source_versions_recorded",
  ],
} as AgentStepContractV1;

const grant = resolveAgentStepCapabilityGrant({
  contract,
  availableToolNames: ["read_document"],
  readOnlyConnectorPins: [EPO_OPS_SOURCE_CONNECTOR_PIN],
});

const context = {
  taskId: "task-1",
  stepId: "step-1",
  stepPosition: 0,
  attempt: 1,
  matterId: MATTER_ID,
  sourceVersionIds: [],
};

const request = {
  schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
  request_ref: "request-1",
  operation: "search" as const,
  query: "ti=sensor",
  external_id: null,
  jurisdiction: "US",
  as_of_date: "2026-08-08",
  page: 1,
  page_size: 10,
};

const spec = {
  schema_version: PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
  query: "ti=sensor",
  jurisdiction: "US",
  as_of_date: "2026-08-08",
  maximum_pages: 2,
  page_size: 10,
  maximum_selections: 5,
};

const discovery = {
  schema_version: "read_only_source_discovery_v1",
  discovery_ref: "epo-ops:publication:US7654321A1",
  provider_id: "epo-ops",
  external_id: "publication:US7654321A1",
  source_kind: "patent_publication",
  title: "Sensor system",
  canonical_url:
    "https://worldwide.espacenet.com/patent/search?q=pn%3DUS7654321A1",
  published_on: "2025-01-01",
  not_citable: true,
  metadata: {},
};

test("the fixed acquisition spec compiles bounded search and selected-read requests", () => {
  assert.deepEqual(
    compileProviderSourceSearchRequest({
      spec,
      pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
      requestRef: "search-page-2",
      page: 2,
    }),
    {
      schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
      request_ref: "search-page-2",
      operation: "search",
      query: "ti=sensor",
      external_id: null,
      jurisdiction: "US",
      as_of_date: "2026-08-08",
      page: 2,
      page_size: 10,
    },
  );
  assert.deepEqual(
    compileProviderSourceSelectedReadRequest({
      spec,
      pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
      requestRef: "selected-1",
      discovery,
    }),
    {
      schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
      request_ref: "selected-1",
      operation: "read_snapshot",
      query: null,
      external_id: "publication:US7654321A1",
      jurisdiction: "US",
      as_of_date: "2026-08-08",
      page: null,
      page_size: null,
    },
  );
});

test("the acquisition compiler rejects connector, page, jurisdiction, and discovery widening", () => {
  assert.throws(
    () =>
      compileProviderSourceSearchRequest({
        spec,
        pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
        requestRef: "page-3",
        page: 3,
      }),
    /page exceeds fixed scope/,
  );
  assert.throws(
    () =>
      validateProviderSourceAcquisitionSpec(
        { ...spec, jurisdiction: "ZZ" },
        EPO_OPS_SOURCE_CONNECTOR_PIN,
      ),
    /exceeds its fixed pin/,
  );
  assert.throws(
    () =>
      validateProviderSourceAcquisitionSpec(
        { ...spec, connector_id: "model.selected.connector" },
        EPO_OPS_SOURCE_CONNECTOR_PIN,
      ),
    /exceeds its fixed pin/,
  );
  assert.throws(
    () =>
      compileProviderSourceSelectedReadRequest({
        spec,
        pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
        requestRef: "forged-selection",
        discovery: {
          ...discovery,
          provider_id: "other-provider",
        },
      }),
    /does not match the fixed connector/,
  );
});

test("the acquisition bridge binds current user, Task scope, runtime, and central pipeline", async () => {
  const seen: Record<string, unknown> = {};
  const outcome = await executeCurrentUserProviderSourceAcquisition({
    db: {} as never,
    userId: USER_ID,
    matterId: MATTER_ID,
    connectorId: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    operation: "search",
    context,
    grant,
    request,
    now: () => NOW,
    dependencies: {
      resolveRuntime: async (input) => {
        seen.runtime = input;
        return {
          pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
          authorization: {
            schema_version: "read_only_source_authorization_v1",
            connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
            connection: "connected",
            subscription: "not_required",
            checked_at: NOW,
          },
          invoker: {
            connectorId: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
            host: "ops.epo.org",
            binding: EPO_OPS_SOURCE_CONNECTOR_PIN.binding,
            async invoke() {
              throw new Error("pipeline stub must own execution");
            },
          },
          normalizer: {
            pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
            async normalize() {
              throw new Error("pipeline stub must own normalization");
            },
          },
        };
      },
      executePipeline: async (input) => {
        seen.pipeline = input;
        return {
          kind: "completed",
          operation: "search",
          discoveries: [],
          coverage: {
            schema_version: "read_only_source_coverage_v1",
            request_ref: request.request_ref,
            status: "complete",
            pages_examined: 1,
            items_examined: 0,
            truncated: false,
            gaps: [],
          },
          receipt: {
            schema_version: "read_only_source_receipt_v2",
          } as never,
          imports: [],
        };
      },
    },
  });
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(
    {
      connectorId: (seen.runtime as { connectorId: string }).connectorId,
      operation: (seen.runtime as { operation: string }).operation,
      userId: (seen.runtime as { userId: string }).userId,
    },
    {
      connectorId: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
      operation: "search",
      userId: USER_ID,
    },
  );
  const pipeline = seen.pipeline as {
    userId: string;
    matterId: string;
    execution: { context: typeof context; request: typeof request };
  };
  assert.equal(pipeline.userId, USER_ID);
  assert.equal(pipeline.matterId, MATTER_ID);
  assert.deepEqual(pipeline.execution.context, context);
  assert.deepEqual(pipeline.execution.request, request);
});
