import assert from "node:assert/strict";
import test from "node:test";

import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import {
  PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  compileProviderSourceSearchRequest,
} from "./providerSourceAcquisition";
import {
  appendProviderSourceSearchPage,
  createProviderSourceAcquisitionState,
  selectProviderSourceDiscoveries,
  selectedProviderSourceDiscoveries,
} from "./providerSourceAcquisitionState";

const NOW = "2026-08-08T10:00:00.000Z";
const spec = {
  schema_version: PROVIDER_SOURCE_ACQUISITION_SPEC_VERSION,
  connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
  query: "ti=sensor",
  jurisdiction: "US",
  as_of_date: "2026-08-08",
  maximum_pages: 2,
  page_size: 2,
  maximum_selections: 2,
};

function discovery(id: string) {
  return {
    schema_version: "read_only_source_discovery_v1" as const,
    discovery_ref: `epo-ops:publication:${id}`,
    provider_id: "epo-ops",
    external_id: `publication:${id}`,
    source_kind: "patent_publication",
    title: `Publication ${id}`,
    canonical_url: `https://worldwide.espacenet.com/patent/search?q=pn%3D${id}`,
    published_on: "2025-01-01",
    not_citable: true as const,
    metadata: {},
  };
}

function searchOutcome(input: {
  requestRef: string;
  discoveries: ReturnType<typeof discovery>[];
  truncated: boolean;
}) {
  return {
    kind: "completed" as const,
    operation: "search" as const,
    discoveries: input.discoveries,
    coverage: {
      schema_version: "read_only_source_coverage_v1" as const,
      request_ref: input.requestRef,
      status: input.truncated ? ("incomplete" as const) : ("complete" as const),
      pages_examined: 1,
      items_examined: input.discoveries.length,
      truncated: input.truncated,
      gaps: input.truncated
        ? [
            {
              code: "pagination_truncated" as const,
              detail: "More results remain.",
            },
          ]
        : [],
    },
    receipt: {
      schema_version: "read_only_source_receipt_v2" as const,
      task_id: "task-1",
      step_id: "step-1",
      step_position: 0,
      attempt: 1,
      matter_id: "22222222-2222-4222-8222-222222222222",
      source_version_ids: [],
      connector_pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
      authorization: {
        schema_version: "read_only_source_authorization_v1" as const,
        connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
        connection: "connected" as const,
        subscription: "not_required" as const,
        checked_at: NOW,
      },
      request_ref: input.requestRef,
      operation: "search" as const,
      egress_fields_sent: [
        "query" as const,
        "jurisdiction" as const,
        "as_of_date" as const,
        "page" as const,
        "page_size" as const,
      ],
      external_call_attempted: true,
      external_side_effect: "none" as const,
      status: "ok" as const,
      error_category: null,
      returned_discovery_refs: input.discoveries.map(
        (item) => item.discovery_ref,
      ),
      returned_snapshot_refs: [],
      started_at: NOW,
      completed_at: NOW,
      idempotency_key: `source:${"a".repeat(64)}`,
    },
    imports: [] as [],
  };
}

test("search pages remain bounded and finish at an exact lawyer-selection checkpoint", () => {
  const initial = createProviderSourceAcquisitionState({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
  });
  const request1 = compileProviderSourceSearchRequest({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    requestRef: "search-1",
    page: 1,
  });
  const page1 = appendProviderSourceSearchPage({
    state: initial,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    request: request1,
    outcome: searchOutcome({
      requestRef: "search-1",
      discoveries: [discovery("US1A1"), discovery("US2A1")],
      truncated: true,
    }),
  });
  assert.equal(page1.phase, "search_pending");
  assert.equal(page1.next_page, 2);

  const request2 = compileProviderSourceSearchRequest({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    requestRef: "search-2",
    page: 2,
  });
  const page2 = appendProviderSourceSearchPage({
    state: page1,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    request: request2,
    outcome: searchOutcome({
      requestRef: "search-2",
      discoveries: [discovery("US2A1"), discovery("US3A1")],
      truncated: false,
    }),
  });
  assert.equal(page2.phase, "selection_required");
  assert.equal(page2.next_page, null);
  assert.deepEqual(
    page2.discoveries.map((item) => item.discovery_ref),
    [
      "epo-ops:publication:US1A1",
      "epo-ops:publication:US2A1",
      "epo-ops:publication:US3A1",
    ],
  );

  const selected = selectProviderSourceDiscoveries({
    state: page2,
    discoveryRefs: [
      "epo-ops:publication:US1A1",
      "epo-ops:publication:US3A1",
    ],
  });
  assert.equal(selected.phase, "read_pending");
  assert.deepEqual(
    selectedProviderSourceDiscoveries(selected).map(
      (item) => item.external_id,
    ),
    ["publication:US1A1", "publication:US3A1"],
  );
});

test("selection cannot invent a provider result or exceed the fixed limit", () => {
  const initial = createProviderSourceAcquisitionState({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
  });
  const request = compileProviderSourceSearchRequest({
    spec,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    requestRef: "search-1",
    page: 1,
  });
  const state = appendProviderSourceSearchPage({
    state: initial,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    request,
    outcome: searchOutcome({
      requestRef: "search-1",
      discoveries: [discovery("US1A1")],
      truncated: false,
    }),
  });
  assert.throws(
    () =>
      selectProviderSourceDiscoveries({
        state,
        discoveryRefs: ["epo-ops:publication:FORGED"],
      }),
    /not a returned discovery/,
  );
  assert.throws(
    () =>
      selectProviderSourceDiscoveries({
        state,
        discoveryRefs: ["a", "b", "c"],
      }),
    /exceeds fixed scope/,
  );
  const mismatched = searchOutcome({
    requestRef: "search-1",
    discoveries: [discovery("US1A1")],
    truncated: false,
  });
  mismatched.receipt.returned_discovery_refs = [];
  assert.throws(
    () =>
      appendProviderSourceSearchPage({
        state: initial,
        pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
        request,
        outcome: mismatched,
      }),
    /receipt does not match discoveries/,
  );
});
