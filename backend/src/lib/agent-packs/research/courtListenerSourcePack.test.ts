import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentStepCapabilityGrant } from "../../agent-kernel/capability/stepCapability";
import {
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  READ_ONLY_SOURCE_REQUEST_VERSION,
} from "../../agent-kernel/connectors/readOnlySourceContract";
import { executeReadOnlySourceConnector } from "../../agent-kernel/connectors/readOnlySourceExecution";
import type { AgentStepContractV1 } from "../../agent-kernel/contracts/stepContract";
import {
  COURTLISTENER_SOURCE_CONNECTOR_PIN,
  createCourtListenerSourceInvoker,
  createCourtListenerSourceNormalizer,
} from "./courtListenerSourcePack";

const NOW = "2026-08-08T01:00:00.000Z";
const API_TOKEN = "fixture-secret-token";

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
  readOnlyConnectorPins: [COURTLISTENER_SOURCE_CONNECTOR_PIN],
});

const authorization = {
  schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  connector_id: COURTLISTENER_SOURCE_CONNECTOR_PIN.connector_id,
  connection: "connected" as const,
  subscription: "not_required" as const,
  checked_at: NOW,
};

const context = {
  taskId: "task-1",
  stepId: "step-1",
  stepPosition: 0,
  attempt: 1,
  matterId: "matter-1",
  sourceVersionIds: ["version-1"],
};

const searchRequest = {
  schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
  request_ref: "court-search-1",
  operation: "search" as const,
  query: "contract interpretation",
  external_id: null,
  jurisdiction: "US",
  as_of_date: "2026-08-08",
  page: 1,
  page_size: 2,
};

test("CourtListener search returns non-citable discoveries without importing them", async () => {
  let receivedToken: string | null | undefined;
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: COURTLISTENER_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createCourtListenerSourceInvoker({
      operation: "search",
      apiToken: API_TOKEN,
      search: async (input) => {
        receivedToken = input.apiToken;
        assert.equal(input.query, searchRequest.query);
        assert.equal(input.filedBefore, searchRequest.as_of_date);
        assert.equal(input.limit, searchRequest.page_size);
        return {
          query: searchRequest.query,
          results: [
            {
              clusterId: 123,
              caseName: "Fixture v. Example",
              citation: "1 F.4th 2",
              court: "ca9",
              dateFiled: "2024-01-02",
              snippet: "Provider search snippet",
              url: "https://www.courtlistener.com/opinion/123/fixture/",
            },
          ],
        };
      },
    }),
    normalizer: createCourtListenerSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });

  assert.equal(receivedToken, API_TOKEN);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.discoveries.length, 1);
  assert.equal(result.discoveries[0]?.not_citable, true);
  assert.equal(result.discoveries[0]?.external_id, "123");
  assert.deepEqual(result.importCandidates, []);
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(result.receipt.returned_discovery_refs, [
    "courtlistener:cluster:123",
  ]);
  const receipt = JSON.stringify(result.receipt);
  assert.doesNotMatch(receipt, /fixture-secret-token|Provider search snippet/);
});

test("CourtListener selected read yields one immutable import-only snapshot", async () => {
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: COURTLISTENER_SOURCE_CONNECTOR_PIN,
    authorization,
    request: {
      ...searchRequest,
      request_ref: "court-read-1",
      operation: "read_snapshot",
      query: null,
      external_id: "123",
      page: null,
      page_size: null,
    },
    invoker: createCourtListenerSourceInvoker({
      operation: "read_snapshot",
      apiToken: API_TOKEN,
      read: async (input) => {
        assert.equal(input.clusterId, 123);
        return {
          id: 123,
          url: "https://www.courtlistener.com/opinion/123/fixture/",
          caseName: "Fixture v. Example",
          dateFiled: "2024-01-02",
          citations: ["1 F.4th 2"],
          opinions: [
            {
              opinionId: 456,
              type: "010combined",
              author: "Example Judge",
              per_curiam: null,
              joined_by_str: null,
              url: "https://www.courtlistener.com/opinion/456/fixture/",
              text: "The fixed opinion text controls this snapshot.",
              html: "<p>The fixed opinion text controls this snapshot.</p>",
            },
          ],
          source: "api",
        };
      },
    }),
    normalizer: createCourtListenerSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.deepEqual(result.discoveries, []);
  assert.equal(result.importCandidates.length, 1);
  assert.equal(result.importCandidates[0]?.as_of_date, null);
  assert.equal(
    result.importCandidates[0]?.source_body,
    "The fixed opinion text controls this snapshot.",
  );
  assert.match(
    result.importCandidates[0]?.content_sha256 ?? "",
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.receipt),
    /fixed opinion text|fixture-secret-token/,
  );
});

test("CourtListener rejects jurisdiction widening before external execution", async () => {
  let calls = 0;
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: COURTLISTENER_SOURCE_CONNECTOR_PIN,
    authorization,
    request: { ...searchRequest, jurisdiction: "CN" },
    invoker: createCourtListenerSourceInvoker({
      operation: "search",
      apiToken: API_TOKEN,
      search: async () => {
        calls += 1;
        return { query: searchRequest.query, results: [] };
      },
    }),
    normalizer: createCourtListenerSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "connector_jurisdiction_not_allowed");
  assert.equal(result.receipt.external_call_attempted, false);
  assert.equal(calls, 0);
});

test("CourtListener capacity and malformed output remain distinct pauses", async () => {
  const capacity = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: COURTLISTENER_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createCourtListenerSourceInvoker({
      operation: "search",
      apiToken: API_TOKEN,
      search: async () => {
        throw new Error("CourtListener rate limit exceeded (429)");
      },
    }),
    normalizer: createCourtListenerSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(capacity.kind, "provider_pause");
  if (capacity.kind === "provider_pause") {
    assert.equal(capacity.classification, "provider_capacity");
  }

  const malformed = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: COURTLISTENER_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createCourtListenerSourceInvoker({
      operation: "search",
      apiToken: API_TOKEN,
      search: async () => ({ query: searchRequest.query, results: [{}] }),
    }),
    normalizer: createCourtListenerSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(malformed.kind, "provider_pause");
  if (malformed.kind === "provider_pause") {
    assert.equal(malformed.classification, "provider_structured_output");
  }
});
