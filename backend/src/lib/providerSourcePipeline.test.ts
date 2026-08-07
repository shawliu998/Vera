import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentStepCapabilityGrant } from "./agent-kernel/capability/stepCapability";
import {
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  READ_ONLY_SOURCE_REQUEST_VERSION,
} from "./agent-kernel/connectors/readOnlySourceContract";
import type { AgentStepContractV1 } from "./agent-kernel/contracts/stepContract";
import {
  EPO_OPS_SOURCE_CONNECTOR_PIN,
  createEpoOpsSourceInvoker,
  createEpoOpsSourceNormalizer,
  type EpoOpsSourcePrimitivesV1,
} from "./agent-packs/patent/epoOpsSourcePack";
import {
  ProviderSourcePipelineError,
  executeProviderSourcePipeline,
} from "./providerSourcePipeline";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const MATTER_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-08-08T05:00:00.000Z";
const BODY_TEXT = "A fixed sensor system claim.";
const BIBLIO_XML = `<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:ex="http://www.epo.org/exchange"><ops:biblio-search total-result-count="1"><ex:exchange-document country="US" doc-number="7654321" kind="A1"><ex:bibliographic-data><ex:publication-reference><ex:document-id document-id-type="docdb"><ex:country>US</ex:country><ex:doc-number>7654321</ex:doc-number><ex:kind>A1</ex:kind><ex:date>20250101</ex:date></ex:document-id></ex:publication-reference><ex:invention-title lang="en">Sensor system</ex:invention-title></ex:bibliographic-data></ex:exchange-document></ops:biblio-search></ops:world-patent-data>`;
const CLAIMS_XML = `<ft:fulltext-documents xmlns:ft="http://www.epo.org/fulltext"><ft:claim><ft:claim-text>${BODY_TEXT}</ft:claim-text></ft:claim></ft:fulltext-documents>`;

const contract = {
  schema_version: "agent_step_contract_v1",
  position: 0,
  capability: "read_sources",
  operation: "read",
  output_expectation: { kind: "checkpoint" },
  source_requirement: {
    mode: "authority",
    citations_required: true,
    authority_as_of_required: true,
    jurisdictions: ["US"],
    as_of_date: "2025-01-02",
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

const primitives: EpoOpsSourcePrimitivesV1 = {
  async getAccessToken() {
    return { accessToken: "pipeline-token", expiresInSeconds: 3_600 };
  },
  async searchBiblio() {
    return BIBLIO_XML;
  },
  async readBiblio() {
    return BIBLIO_XML;
  },
  async readFullText() {
    return { descriptionXml: null, claimsXml: CLAIMS_XML };
  },
};

function execution(operation: "search" | "read_snapshot") {
  return {
    context: {
      taskId: "pipeline-task",
      stepId: "pipeline-step",
      stepPosition: 0,
      attempt: 1,
      matterId: MATTER_ID,
      sourceVersionIds: [],
    },
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization: {
      schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
      connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
      connection: "connected" as const,
      subscription: "verified" as const,
      checked_at: NOW,
    },
    request: {
      schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
      request_ref: `pipeline-${operation}`,
      operation,
      query: operation === "search" ? "ti=sensor" : null,
      external_id:
        operation === "read_snapshot" ? "publication:US7654321A1" : null,
      jurisdiction: "US",
      as_of_date: "2025-01-02",
      page: operation === "search" ? 1 : null,
      page_size: operation === "search" ? 10 : null,
    },
    invoker: createEpoOpsSourceInvoker({
      operation,
      credentials: { consumerKey: "key", consumerSecret: "secret" },
      primitives,
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  };
}

test("the EPO selected-read pipeline consumes the body and returns only import receipts", async () => {
  let importedBody = "";
  const result = await executeProviderSourcePipeline({
    db: {} as never,
    userId: USER_ID,
    matterId: MATTER_ID,
    execution: execution("read_snapshot"),
    dependencies: {
      import: async (input) => {
        importedBody = String((input.snapshot as { source_body: string }).source_body);
        return {
          schema_version: "provider_source_import_receipt_v1",
          provider_id: "epo-ops",
          external_id: "publication:US7654321A1",
          snapshot_ref: "epo-ops:publication:US7654321A1",
          content_sha256: `sha256:${"1".repeat(64)}`,
          document_id: "00000000-0000-4000-8000-000000000003",
          version_id: "00000000-0000-4000-8000-000000000004",
          version_number: 1,
          filename: "Sensor system.json",
          created: true,
          current_version_id: "00000000-0000-4000-8000-000000000004",
        };
      },
    },
  });
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.operation, "read_snapshot");
  assert.match(importedBody, new RegExp(BODY_TEXT));
  assert.equal("importCandidates" in result, false);
  assert.equal(JSON.stringify(result).includes(BODY_TEXT), false);
  assert.equal(result.imports.length, 1);
});

test("the pipeline returns search discoveries without invoking the importer", async () => {
  let importCalls = 0;
  const result = await executeProviderSourcePipeline({
    db: {} as never,
    userId: USER_ID,
    matterId: MATTER_ID,
    execution: execution("search"),
    dependencies: {
      import: async () => {
        importCalls += 1;
        throw new Error("search_must_not_import");
      },
    },
  });
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.operation, "search");
  assert.equal(result.discoveries.length, 1);
  assert.deepEqual(result.imports, []);
  assert.equal(importCalls, 0);
});

test("the pipeline rejects a cross-Matter execution context before provider use", async () => {
  const drifted = execution("search");
  drifted.context.matterId = "00000000-0000-4000-8000-000000000099";
  await assert.rejects(
    () =>
      executeProviderSourcePipeline({
        db: {} as never,
        userId: USER_ID,
        matterId: MATTER_ID,
        execution: drifted,
      }),
    (error) =>
      error instanceof ProviderSourcePipelineError &&
      error.code === "scope_invalid",
  );
});
