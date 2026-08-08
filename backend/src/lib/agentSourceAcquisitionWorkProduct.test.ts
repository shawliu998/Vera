import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSourceAcquisitionWorkProductContext } from "./agentSourceAcquisitionWorkProduct";
import { providerSourceAcquisitionStateSchema } from "./providerSourceAcquisitionState";

const completed = providerSourceAcquisitionStateSchema.parse({
  schema_version: "provider_source_acquisition_state_v1",
  spec: {
    schema_version: "provider_source_acquisition_spec_v1",
    connector_id: "patent.epo-ops.publications",
    query: "ti=sensor",
    jurisdiction: "US",
    as_of_date: "2026-08-08",
    maximum_pages: 3,
    page_size: 25,
    maximum_selections: 10,
  },
  phase: "completed",
  next_page: null,
  discoveries: [
    {
      schema_version: "read_only_source_discovery_v1",
      discovery_ref: "epo-ops:publication:US7654321A1",
      provider_id: "epo-ops",
      external_id: "publication:US7654321A1",
      source_kind: "patent_publication",
      title: "Optical sensor publication",
      canonical_url:
        "https://worldwide.espacenet.com/patent/search?q=pn%3DUS7654321A1",
      published_on: "2025-01-01",
      not_citable: true,
      metadata: {},
    },
  ],
  selected_discovery_refs: ["epo-ops:publication:US7654321A1"],
  search_receipts: [],
  search_coverage: [
    {
      schema_version: "read_only_source_coverage_v1",
      request_ref: "search-1",
      status: "incomplete",
      pages_examined: 1,
      items_examined: 25,
      truncated: true,
      gaps: [
        {
          code: "pagination_truncated",
          detail: "The fixed three-page search bound was reached.",
        },
      ],
    },
  ],
  read_receipts: [],
  import_receipts: [
    {
      schema_version: "provider_source_import_receipt_v1",
      provider_id: "epo-ops",
      external_id: "publication:US7654321A1",
      snapshot_ref: "epo-ops:publication:US7654321A1",
      content_sha256: `sha256:${"a".repeat(64)}`,
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      version_number: 1,
      filename: "US7654321A1.json",
      created: true,
      current_version_id: "55555555-5555-4555-8555-555555555555",
    },
  ],
  issues: [],
});

test("projects only completed server-validated scope, coverage, selection and Version facts", () => {
  const context = buildAgentSourceAcquisitionWorkProductContext({
    source_acquisition: completed,
  });
  assert.ok(context);
  assert.match(context, /SERVER-VALIDATED PRIOR ART ACQUISITION FACTS/);
  assert.match(context, /"query": "ti=sensor"/);
  assert.match(context, /"items_examined": 25/);
  assert.match(context, /"truncated": true/);
  assert.match(context, /US7654321A1/);
  assert.match(context, /55555555-5555-4555-8555-555555555555/);
  assert.equal(context.includes("authorization"), false);
  assert.equal(context.includes("egress_fields_sent"), false);
});

test("does not expose incomplete or malformed acquisition state to downstream drafting", () => {
  assert.equal(
    buildAgentSourceAcquisitionWorkProductContext({
      source_acquisition: { ...completed, phase: "read_pending" },
    }),
    null,
  );
  assert.equal(buildAgentSourceAcquisitionWorkProductContext({}), null);
});
