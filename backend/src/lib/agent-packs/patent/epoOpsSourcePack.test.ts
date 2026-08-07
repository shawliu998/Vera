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
  EPO_OPS_SOURCE_CONNECTOR_PIN,
  createEpoOpsSourceInvoker,
  createEpoOpsSourceNormalizer,
  type EpoOpsSourcePrimitivesV1,
} from "./epoOpsSourcePack";

const NOW = "2026-08-08T04:00:00.000Z";
const AS_OF_DATE = "2025-01-03";
const CREDENTIALS = {
  consumerKey: "fixture-consumer-key",
  consumerSecret: "fixture-consumer-secret",
};

const BIBLIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:ex="http://www.epo.org/exchange">
  <ops:biblio-search total-result-count="1">
    <ops:search-result><ex:exchange-documents>
      <ex:exchange-document country="US" doc-number="1234567" kind="A1" family-id="9988">
        <ex:bibliographic-data>
          <ex:publication-reference><ex:document-id document-id-type="docdb">
            <ex:country>US</ex:country><ex:doc-number>1234567</ex:doc-number><ex:kind>A1</ex:kind><ex:date>20250102</ex:date>
          </ex:document-id></ex:publication-reference>
          <ex:application-reference><ex:document-id document-id-type="docdb"><ex:date>20230604</ex:date></ex:document-id></ex:application-reference>
          <ex:priority-claims><ex:priority-claim><ex:document-id document-id-type="docdb"><ex:date>20220605</ex:date></ex:document-id></ex:priority-claim></ex:priority-claims>
          <ex:parties>
            <ex:applicants><ex:applicant><ex:applicant-name><ex:name>Atlas Robotics Ltd.</ex:name></ex:applicant-name></ex:applicant></ex:applicants>
            <ex:inventors><ex:inventor><ex:inventor-name><ex:name>Lin Qiao</ex:name></ex:inventor-name></ex:inventor></ex:inventors>
          </ex:parties>
          <ex:classifications-ipcr><ex:classification-ipcr><ex:text>G06F 3/01</ex:text></ex:classification-ipcr></ex:classifications-ipcr>
          <ex:invention-title lang="de">Steuerung</ex:invention-title>
          <ex:invention-title lang="en">Adaptive robotic control</ex:invention-title>
        </ex:bibliographic-data>
        <ex:abstract lang="en"><ex:p>A controller adapts a motion path.</ex:p></ex:abstract>
      </ex:exchange-document>
    </ex:exchange-documents></ops:search-result>
  </ops:biblio-search>
</ops:world-patent-data>`;

const FULL_TEXT_XML = `<?xml version="1.0"?>
<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:ft="http://www.epo.org/fulltext">
  <ft:fulltext-documents><ft:fulltext-document>
    <ft:description><ft:p>The controller receives sensor data.</ft:p><ft:p>It updates the path.</ft:p></ft:description>
    <ft:claims>
      <ft:claim><ft:claim-text>A system comprising a sensor and controller.</ft:claim-text></ft:claim>
      <ft:claim><ft:claim-text>The system of claim 1, wherein the path is adaptive.</ft:claim-text></ft:claim>
    </ft:claims>
  </ft:fulltext-document></ft:fulltext-documents>
</ops:world-patent-data>`;

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
    as_of_date: AS_OF_DATE,
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

const authorization = {
  schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
  connection: "connected" as const,
  subscription: "verified" as const,
  checked_at: NOW,
};

const context = {
  taskId: "patent-task-1",
  stepId: "patent-step-1",
  stepPosition: 0,
  attempt: 1,
  matterId: "patent-matter-1",
  sourceVersionIds: [],
};

const searchRequest = {
  schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
  request_ref: "epo-search-1",
  operation: "search" as const,
  query: "ti=robot",
  external_id: null,
  jurisdiction: "US",
  as_of_date: AS_OF_DATE,
  page: 1,
  page_size: 10,
};

function primitives(input: {
  calls: string[];
  biblioXml?: string;
  fullText?: { descriptionXml: string | null; claimsXml: string | null };
}): EpoOpsSourcePrimitivesV1 {
  return {
    async getAccessToken({ credentials }) {
      assert.deepEqual(credentials, CREDENTIALS);
      input.calls.push("token");
      return { accessToken: "fixture-access-token", expiresInSeconds: 3_600 };
    },
    async searchBiblio({ accessToken, query, range }) {
      assert.equal(accessToken, "fixture-access-token");
      input.calls.push(`search:${query}:${range}`);
      return input.biblioXml ?? BIBLIO_XML;
    },
    async readBiblio({ accessToken, publicationNumber }) {
      assert.equal(accessToken, "fixture-access-token");
      input.calls.push(`biblio:${publicationNumber}`);
      return input.biblioXml ?? BIBLIO_XML;
    },
    async readFullText({ accessToken, publicationNumber }) {
      assert.equal(accessToken, "fixture-access-token");
      input.calls.push(`fulltext:${publicationNumber}`);
      return (
        input.fullText ?? {
          descriptionXml: FULL_TEXT_XML,
          claimsXml: FULL_TEXT_XML,
        }
      );
    },
  };
}

test("EPO OPS search is server-scoped and returns only non-citable discoveries", async () => {
  const calls: string[] = [];
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createEpoOpsSourceInvoker({
      operation: "search",
      credentials: CREDENTIALS,
      primitives: primitives({ calls }),
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.deepEqual(calls, [
    "token",
    "search:(ti=robot) and pn=US and pd<=20250103:1-10",
  ]);
  assert.equal(result.discoveries.length, 1);
  assert.equal(result.discoveries[0]?.not_citable, true);
  assert.equal(
    result.discoveries[0]?.external_id,
    "publication:US1234567A1",
  );
  assert.deepEqual(result.importCandidates, []);
  assert.equal(result.coverage.status, "complete");
  const persisted = JSON.stringify(result.receipt);
  assert.doesNotMatch(
    persisted,
    /fixture-consumer|fixture-access-token|controller adapts/i,
  );
});

test("EPO OPS selected read yields one import-only structured snapshot", async () => {
  const calls: string[] = [];
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: {
      ...searchRequest,
      request_ref: "epo-read-1",
      operation: "read_snapshot",
      query: null,
      external_id: "publication:US1234567A1",
      page: null,
      page_size: null,
    },
    invoker: createEpoOpsSourceInvoker({
      operation: "read_snapshot",
      credentials: CREDENTIALS,
      primitives: primitives({ calls }),
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.deepEqual(calls, [
    "token",
    "biblio:US1234567A1",
    "fulltext:US1234567A1",
  ]);
  assert.equal(result.importCandidates.length, 1);
  const snapshot = result.importCandidates[0]!;
  assert.equal(snapshot.content_type, "application/json");
  assert.equal(snapshot.as_of_date, null);
  assert.equal(snapshot.metadata.publication_date, "2025-01-02");
  const body = JSON.parse(snapshot.source_body);
  assert.equal(body.publication.publicationNumber, "US1234567A1");
  assert.equal(body.claims.length, 2);
  assert.match(snapshot.content_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(result.receipt),
    /fixture-consumer|fixture-access-token|receives sensor data/i,
  );
});

test("EPO OPS rejects a selected publication outside the fixed jurisdiction before egress", async () => {
  const calls: string[] = [];
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: {
      ...searchRequest,
      request_ref: "epo-read-cn-1",
      operation: "read_snapshot",
      query: null,
      external_id: "publication:CN1234567A",
      page: null,
      page_size: null,
    },
    invoker: createEpoOpsSourceInvoker({
      operation: "read_snapshot",
      credentials: CREDENTIALS,
      primitives: primitives({ calls }),
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "connector_request_not_bound");
  assert.equal(result.receipt.external_call_attempted, false);
  assert.deepEqual(calls, []);
});

test("EPO OPS preserves a partial bibliographic snapshot for lawyer review", async () => {
  const calls: string[] = [];
  const result = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: {
      ...searchRequest,
      request_ref: "epo-read-partial-1",
      operation: "read_snapshot",
      query: null,
      external_id: "publication:US1234567A1",
      page: null,
      page_size: null,
    },
    invoker: createEpoOpsSourceInvoker({
      operation: "read_snapshot",
      credentials: CREDENTIALS,
      primitives: primitives({
        calls,
        fullText: { descriptionXml: null, claimsXml: null },
      }),
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.importCandidates.length, 1);
  assert.equal(result.importCandidates[0]?.metadata.full_text_available, false);
  assert.equal(result.coverage.status, "incomplete");
  assert.equal(result.coverage.gaps[0]?.code, "full_text_unavailable");
});

test("EPO OPS capacity and malformed XML remain distinct resumable pauses", async () => {
  const capacityPrimitives = primitives({ calls: [] });
  capacityPrimitives.searchBiblio = async () => {
    throw new Error("EPO OPS rate limit 429");
  };
  const capacity = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createEpoOpsSourceInvoker({
      operation: "search",
      credentials: CREDENTIALS,
      primitives: capacityPrimitives,
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(capacity.kind, "provider_pause");
  if (capacity.kind === "provider_pause") {
    assert.equal(capacity.classification, "provider_capacity");
  }

  const malformed = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createEpoOpsSourceInvoker({
      operation: "search",
      credentials: CREDENTIALS,
      primitives: primitives({ calls: [], biblioXml: "<not-epo />" }),
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(malformed.kind, "provider_pause");
  if (malformed.kind === "provider_pause") {
    assert.equal(malformed.classification, "provider_structured_output");
  }

  const scopeDrift = await executeReadOnlySourceConnector({
    context,
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization,
    request: searchRequest,
    invoker: createEpoOpsSourceInvoker({
      operation: "search",
      credentials: CREDENTIALS,
      primitives: primitives({
        calls: [],
        biblioXml: BIBLIO_XML.replaceAll('country="US"', 'country="CN"')
          .replaceAll("<ex:country>US</ex:country>", "<ex:country>CN</ex:country>"),
      }),
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => NOW }),
    now: () => NOW,
  });
  assert.equal(scopeDrift.kind, "provider_pause");
  if (scopeDrift.kind === "provider_pause") {
    assert.equal(scopeDrift.classification, "provider_structured_output");
  }
});
