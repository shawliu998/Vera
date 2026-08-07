import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { resolveAgentStepCapabilityGrant } from "../capability/stepCapability";
import type { AgentStepContractV1 } from "../contracts/stepContract";
import {
  READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  READ_ONLY_SOURCE_COVERAGE_VERSION,
  READ_ONLY_SOURCE_DISCOVERY_VERSION,
  READ_ONLY_SOURCE_REQUEST_VERSION,
  READ_ONLY_SOURCE_SNAPSHOT_VERSION,
  readOnlySourceConnectorPinSchema,
  readOnlySourceCoverageSchema,
  readOnlySourceSnapshotSchema,
  type ReadOnlySourceConnectorPinV1,
} from "./readOnlySourceContract";
import {
  executeReadOnlySourceConnector,
  ReadOnlySourceInvocationError,
  type ReadOnlySourceNormalizerV1,
} from "./readOnlySourceExecution";

const NOW = "2026-08-08T00:00:00.000Z";
const FIXED_DIGEST = `sha256:${"1".repeat(64)}`;

function pin(
  overrides: Partial<ReadOnlySourceConnectorPinV1> = {},
): ReadOnlySourceConnectorPinV1 {
  return readOnlySourceConnectorPinSchema.parse({
    schema_version: READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
    connector_id: "fixture-source",
    connector_version: "1.0.0",
    provider_id: "fixture-provider",
    provider_version: "2026-08-08",
    adapter_id: "fixture-adapter",
    adapter_version: "1.0.0",
    binding: {
      kind: "http",
      operation_id: "fixture.search",
      operation_version: "1.0.0",
      input_schema_version: "fixture_input_v1",
      input_schema_digest: FIXED_DIGEST,
      output_schema_version: "fixture_output_v1",
      output_schema_digest: FIXED_DIGEST,
    },
    allowed_hosts: ["api.fixture.invalid"],
    allowed_source_hosts: ["source.fixture.invalid"],
    allowed_jurisdictions: ["CN"],
    allowed_operations: ["search"],
    allowed_egress_fields: [
      "query",
      "jurisdiction",
      "as_of_date",
      "page",
      "page_size",
    ],
    limits: {
      timeout_ms: 10_000,
      authorization_max_age_ms: 60_000,
      maximum_pages: 3,
      maximum_items_per_page: 20,
      maximum_query_chars: 500,
      maximum_snapshot_chars: 10_000,
    },
    fixed: true,
    read_only: true,
    ...overrides,
  });
}

function readContract(mode: "authority" | "pinned" = "authority") {
  return {
    schema_version: "agent_step_contract_v1",
    position: 0,
    capability: "read_sources",
    operation: "read",
    output_expectation: { kind: "checkpoint" },
    source_requirement: {
      mode,
      citations_required: true,
      authority_as_of_required: mode === "authority",
      jurisdictions: ["CN"],
      as_of_date: "2026-08-08",
    },
    deterministic_postconditions: [
      "summary_present",
      "source_versions_recorded",
    ],
  } as AgentStepContractV1;
}

function grant(connectorPins: ReadOnlySourceConnectorPinV1[] = [pin()]) {
  return resolveAgentStepCapabilityGrant({
    contract: readContract(),
    availableToolNames: ["read_document", "find_in_document"],
    readOnlyConnectorPins: connectorPins,
  });
}

const request = {
  schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
  request_ref: "request-1",
  operation: "search" as const,
  query: "合同解除 法律后果",
  external_id: null,
  jurisdiction: "CN",
  as_of_date: "2026-08-08",
  page: 1,
  page_size: 10,
};

const context = {
  taskId: "task-1",
  stepId: "step-1",
  stepPosition: 0,
  attempt: 1,
  matterId: "matter-1",
  sourceVersionIds: ["version-1"],
};

const authorization = {
  schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  connector_id: "fixture-source",
  connection: "connected" as const,
  subscription: "verified" as const,
  checked_at: NOW,
};

function boundInvoker(
  invoke: (
    payload: Readonly<Record<string, string | number>>,
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<unknown>,
  connectorPin = pin(),
) {
  return {
    connectorId: connectorPin.connector_id,
    host: "api.fixture.invalid",
    binding: connectorPin.binding,
    invoke,
  };
}

function normalizer(
  connectorPin = pin(),
  mutate?: (snapshot: Record<string, unknown>) => void,
): ReadOnlySourceNormalizerV1 {
  return {
    pin: connectorPin,
    async normalize() {
      const sourceBody = "第一条 合同解除应当保留可重定位的来源文本。";
      const snapshot: Record<string, unknown> = {
        schema_version: READ_ONLY_SOURCE_SNAPSHOT_VERSION,
        snapshot_ref: "snapshot-1",
        provider_id: connectorPin.provider_id,
        external_id: "authority-1",
        source_kind: "authority",
        title: "合成来源",
        canonical_url: "https://source.fixture.invalid/authority-1",
        retrieved_at: NOW,
        as_of_date: "2026-08-08",
        content_type: "text/plain",
        content_sha256: `sha256:${createHash("sha256")
          .update(sourceBody)
          .digest("hex")}`,
        source_body: sourceBody,
        metadata: { issuer: "fixture" },
      };
      mutate?.(snapshot);
      return {
        discoveries: [
          {
            schema_version: READ_ONLY_SOURCE_DISCOVERY_VERSION,
            discovery_ref: "discovery-1",
            provider_id: connectorPin.provider_id,
            external_id: "authority-1",
            source_kind: "authority",
            title: "合成来源",
            canonical_url: "https://source.fixture.invalid/authority-1",
            published_on: "2026-08-08",
            not_citable: true,
            metadata: { issuer: "fixture" },
          },
        ],
        importCandidates: [snapshot],
        coverage: {
          schema_version: READ_ONLY_SOURCE_COVERAGE_VERSION,
          request_ref: request.request_ref,
          status: "complete",
          pages_examined: 1,
          items_examined: 1,
          truncated: false,
          gaps: [],
        },
      };
    },
  };
}

test("executes one server-bound read-only call and keeps bodies out of receipts", async () => {
  const payloads: Array<Record<string, string | number>> = [];
  const result = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(),
    invoker: boundInvoker(async (payload) => {
      payloads.push({ ...payload });
      return { provider: "fixture" };
    }),
    now: () => NOW,
  });

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.deepEqual(payloads, [
    {
      query: request.query,
      jurisdiction: "CN",
      as_of_date: "2026-08-08",
      page: 1,
      page_size: 10,
    },
  ]);
  assert.equal(
    result.importCandidates[0]?.source_body.includes("合同解除"),
    true,
  );
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.discoveries[0]?.not_citable, true);
  assert.equal(result.receipt.external_side_effect, "none");
  assert.equal(result.receipt.external_call_attempted, true);
  assert.match(result.receipt.idempotency_key, /^source:[a-f0-9]{64}$/);
  const serializedReceipt = JSON.stringify(result.receipt);
  assert.doesNotMatch(serializedReceipt, /合同解除|第一条/);
  assert.doesNotMatch(serializedReceipt, /api key|credential|secret/i);
});

test("rejects a provider-specific identity mismatch before network egress", async () => {
  let calls = 0;
  const result = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(),
    invoker: {
      ...boundInvoker(async () => {
        calls += 1;
        return {};
      }),
      acceptsRequest: () => false,
    },
    now: () => NOW,
  });
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") return;
  assert.equal(result.code, "connector_request_not_bound");
  assert.equal(result.receipt.external_call_attempted, false);
  assert.equal(calls, 0);

  const thrown = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(),
    invoker: {
      ...boundInvoker(async () => {
        calls += 1;
        return {};
      }),
      acceptsRequest: () => {
        throw new Error("adapter_preflight_bug");
      },
    },
    now: () => NOW,
  });
  assert.equal(thrown.kind, "rejected");
  assert.equal(thrown.receipt.external_call_attempted, false);
  assert.equal(calls, 0);
});

test("a selected-source read emits no search or pagination fields", async () => {
  const readPin = pin({
    allowed_operations: ["read_snapshot"],
    allowed_egress_fields: ["external_id", "jurisdiction", "as_of_date"],
  });
  const payloads: Array<Record<string, string | number>> = [];
  const result = await executeReadOnlySourceConnector({
    context,
    grant: grant([readPin]),
    pin: readPin,
    authorization,
    request: {
      ...request,
      operation: "read_snapshot",
      query: null,
      external_id: "authority-1",
      page: null,
      page_size: null,
    },
    normalizer: normalizer(readPin),
    invoker: boundInvoker(async (payload) => {
      payloads.push({ ...payload });
      return {};
    }, readPin),
    now: () => NOW,
  });
  assert.equal(result.kind, "completed");
  assert.deepEqual(payloads, [
    {
      external_id: "authority-1",
      jurisdiction: "CN",
      as_of_date: "2026-08-08",
    },
  ]);
});

test("rejects an ungranted or drifted connector before invoking it", async () => {
  let calls = 0;
  const noConnectorGrant = grant([]);
  const rejected = await executeReadOnlySourceConnector({
    context,
    grant: noConnectorGrant,
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(),
    invoker: boundInvoker(async () => {
      calls += 1;
      return {};
    }),
    now: () => NOW,
  });
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.receipt.external_call_attempted, false);
  assert.equal(calls, 0);

  const driftedPin = pin({ provider_version: "2026-08-09" });
  const drifted = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: driftedPin,
    authorization,
    request,
    normalizer: normalizer(driftedPin),
    invoker: boundInvoker(async () => {
      calls += 1;
      return {};
    }, driftedPin),
    now: () => NOW,
  });
  assert.equal(drifted.kind, "rejected");
  assert.equal(calls, 0);

  const staleAuthorization = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization: {
      ...authorization,
      checked_at: "2026-08-07T23:00:00.000Z",
    },
    request,
    normalizer: normalizer(),
    invoker: boundInvoker(async () => {
      calls += 1;
      return {};
    }),
    now: () => NOW,
  });
  assert.equal(staleAuthorization.kind, "rejected");
  assert.equal(calls, 0);

  const wrongHost = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(),
    invoker: {
      ...boundInvoker(async () => {
        calls += 1;
        return {};
      }),
      host: "unapproved.fixture.invalid",
    },
    now: () => NOW,
  });
  assert.equal(wrongHost.kind, "rejected");
  assert.equal(calls, 0);
});

test("enforces the fixed timeout even when a bound invoker does not settle", async () => {
  const timeoutPin = pin({
    limits: {
      ...pin().limits,
      timeout_ms: 250,
    },
  });
  const result = await executeReadOnlySourceConnector({
    context,
    grant: grant([timeoutPin]),
    pin: timeoutPin,
    authorization,
    request,
    normalizer: normalizer(timeoutPin),
    invoker: boundInvoker(
      async (_payload, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      timeoutPin,
    ),
    now: () => NOW,
  });
  assert.equal(result.kind, "provider_pause");
  if (result.kind !== "provider_pause") return;
  assert.equal(result.classification, "provider_timeout");
  assert.equal(result.receipt.error_category, "provider_timeout");
});

test("keeps provider capacity, configuration and network failures separate", async () => {
  for (const classification of [
    "provider_capacity",
    "provider_configuration",
    "provider_protocol",
  ] as const) {
    const result = await executeReadOnlySourceConnector({
      context,
      grant: grant(),
      pin: pin(),
      authorization,
      request,
      normalizer: normalizer(),
      invoker: boundInvoker(async () => {
        throw new ReadOnlySourceInvocationError(classification);
      }),
      now: () => NOW,
    });
    assert.equal(result.kind, "provider_pause");
    if (result.kind !== "provider_pause") continue;
    assert.equal(result.classification, classification);
    assert.equal(result.receipt.error_category, classification);
  }

  const unknownFailure = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(),
    invoker: boundInvoker(async () => {
      throw new Error("socket closed");
    }),
    now: () => NOW,
  });
  assert.equal(unknownFailure.kind, "provider_pause");
  if (unknownFailure.kind !== "provider_pause") return;
  assert.equal(unknownFailure.classification, "provider_network");
  assert.equal(unknownFailure.receipt.error_category, "provider_network");
});

test("normalization drift pauses provider execution and preserves a body-free receipt", async () => {
  const result = await executeReadOnlySourceConnector({
    context,
    grant: grant(),
    pin: pin(),
    authorization,
    request,
    normalizer: normalizer(pin(), (snapshot) => {
      snapshot.content_sha256 = `sha256:${"0".repeat(64)}`;
    }),
    invoker: boundInvoker(async () => ({})),
    now: () => NOW,
  });
  assert.equal(result.kind, "provider_pause");
  if (result.kind !== "provider_pause") return;
  assert.equal(result.classification, "provider_structured_output");
  assert.equal(result.receipt.status, "error");
  assert.deepEqual(result.receipt.returned_snapshot_refs, []);
});

test("rejects normalized result counts and coverage beyond the fixed pin", async () => {
  const boundedPin = pin({
    limits: {
      ...pin().limits,
      maximum_pages: 1,
      maximum_items_per_page: 1,
    },
  });
  const overCount = normalizer(boundedPin);
  overCount.normalize = async (input) => {
    const base = await normalizer(boundedPin).normalize(input);
    return {
      ...base,
      importCandidates: [
        ...base.importCandidates,
        {
          ...(base.importCandidates[0] as Record<string, unknown>),
          snapshot_ref: "snapshot-2",
          external_id: "authority-2",
        },
      ],
    };
  };
  const result = await executeReadOnlySourceConnector({
    context,
    grant: grant([boundedPin]),
    pin: boundedPin,
    authorization,
    request: { ...request, page_size: 1 },
    normalizer: overCount,
    invoker: boundInvoker(async () => ({}), boundedPin),
    now: () => NOW,
  });
  assert.equal(result.kind, "provider_pause");
  if (result.kind !== "provider_pause") return;
  assert.equal(result.classification, "provider_structured_output");

  const overDiscoveries = normalizer(boundedPin);
  overDiscoveries.normalize = async (input) => {
    const base = await normalizer(boundedPin).normalize(input);
    return {
      ...base,
      discoveries: [
        ...base.discoveries,
        {
          ...(base.discoveries[0] as Record<string, unknown>),
          discovery_ref: "discovery-2",
          external_id: "authority-2",
        },
      ],
    };
  };
  const discoveryResult = await executeReadOnlySourceConnector({
    context,
    grant: grant([boundedPin]),
    pin: boundedPin,
    authorization,
    request: { ...request, page_size: 1 },
    normalizer: overDiscoveries,
    invoker: boundInvoker(async () => ({}), boundedPin),
    now: () => NOW,
  });
  assert.equal(discoveryResult.kind, "provider_pause");
  if (discoveryResult.kind !== "provider_pause") return;
  assert.equal(discoveryResult.classification, "provider_structured_output");

  const overCoverage = normalizer(boundedPin);
  overCoverage.normalize = async (input) => {
    const base = await normalizer(boundedPin).normalize(input);
    return {
      ...base,
      coverage: {
        ...base.coverage,
        pages_examined: 2,
        items_examined: 2,
      },
    };
  };
  const coverageResult = await executeReadOnlySourceConnector({
    context,
    grant: grant([boundedPin]),
    pin: boundedPin,
    authorization,
    request: { ...request, page_size: 1 },
    normalizer: overCoverage,
    invoker: boundInvoker(async () => ({}), boundedPin),
    now: () => NOW,
  });
  assert.equal(coverageResult.kind, "provider_pause");
  if (coverageResult.kind !== "provider_pause") return;
  assert.equal(coverageResult.classification, "provider_structured_output");
});

test("provider snapshots cannot forge Vera identities or unsupported source hosts", () => {
  const sourceBody = "bounded source";
  const base = {
    schema_version: READ_ONLY_SOURCE_SNAPSHOT_VERSION,
    snapshot_ref: "snapshot-1",
    provider_id: "fixture-provider",
    external_id: "external-1",
    source_kind: "authority",
    title: "Fixture",
    canonical_url: "https://source.fixture.invalid/item",
    retrieved_at: NOW,
    as_of_date: null,
    content_type: "text/plain",
    content_sha256: `sha256:${createHash("sha256")
      .update(sourceBody)
      .digest("hex")}`,
    source_body: sourceBody,
    metadata: {},
  };
  assert.equal(
    readOnlySourceSnapshotSchema.parse(base).snapshot_ref,
    "snapshot-1",
  );
  assert.throws(
    () =>
      readOnlySourceSnapshotSchema.parse({
        ...base,
        metadata: { document_id: "forged" },
      }),
    /Vera object identities/,
  );
  assert.throws(
    () =>
      readOnlySourceSnapshotSchema.parse({
        ...base,
        metadata: { source_body: "hidden duplicate" },
      }),
    /import-only source_body channel/,
  );
});

test("coverage cannot claim completeness while a bounded gap remains", () => {
  assert.throws(
    () =>
      readOnlySourceCoverageSchema.parse({
        schema_version: READ_ONLY_SOURCE_COVERAGE_VERSION,
        request_ref: "request-1",
        status: "complete",
        pages_examined: 1,
        items_examined: 20,
        truncated: true,
        gaps: [
          {
            code: "pagination_truncated",
            detail: "The provider reported another page.",
          },
        ],
      }),
    /cannot be complete/,
  );
});

test("only an authority-scoped read Step can receive a connector pin", () => {
  assert.throws(
    () =>
      resolveAgentStepCapabilityGrant({
        contract: readContract("pinned"),
        availableToolNames: ["read_document"],
        readOnlyConnectorPins: [pin()],
      }),
    /authority-scoped read_sources/,
  );
  const resolved = grant();
  assert.equal(resolved.mcp_tools_allowed, false);
  assert.equal(resolved.research_tools_allowed, true);
  assert.equal(
    resolved.read_only_connector_pins[0]?.connector_id,
    "fixture-source",
  );
  assert.throws(
    () => grant([pin(), pin()]),
    /unique identities/,
  );
  assert.throws(
    () =>
      pin({
        binding: { ...pin().binding, kind: "fixture" },
      }),
    /cannot authorize network egress/,
  );
});
