import assert from "node:assert/strict";
import test from "node:test";

import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import {
  AgentTaskSourceAcquisitionInputError,
  compileAgentTaskSourceAcquisition,
} from "./agentTaskSourceAcquisitionCompiler";

const manifest = {
  input_contract: {
    matter_scoped: true as const,
    minimum_documents: 1,
    pinned_document_versions_required: true as const,
    accepted_document_roles: ["source" as const],
    unfixed_client_content_allowed: false as const,
  },
  source_acquisition: {
    schema_version: "provider_source_acquisition_requirement_v1" as const,
    connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    maximum_pages: 3,
    page_size: 25,
    maximum_selections: 10,
  },
};

test("compiles dynamic lawyer scope under the exact manifest and registered connector bounds", () => {
  const compiled = compileAgentTaskSourceAcquisition({
    manifest,
    request: {
      query: "  ti=optical sensor  ",
      jurisdiction: "us",
      as_of_date: "2026-08-08",
    },
    documentCount: 1,
  });
  assert.ok(compiled);
  assert.deepEqual(compiled.spec, {
    schema_version: "provider_source_acquisition_spec_v1",
    connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    query: "ti=optical sensor",
    jurisdiction: "US",
    as_of_date: "2026-08-08",
    maximum_pages: 3,
    page_size: 25,
    maximum_selections: 10,
  });
  assert.equal(compiled.pin, EPO_OPS_SOURCE_CONNECTOR_PIN);
  assert.equal(compiled.state.phase, "search_pending");
  assert.deepEqual(compiled.jurisdictions, ["US"]);
  assert.equal(compiled.asOfDate, "2026-08-08");
});

test("requires one fixed target and exact structured scope only for an acquisition Workflow", () => {
  assert.throws(
    () =>
      compileAgentTaskSourceAcquisition({
        manifest,
        request: {
          query: "ti=sensor",
          jurisdiction: "US",
          as_of_date: "2026-08-08",
        },
        documentCount: 0,
      }),
    (error) =>
      error instanceof AgentTaskSourceAcquisitionInputError &&
      error.code === "source_acquisition_missing_target",
  );
  assert.throws(
    () =>
      compileAgentTaskSourceAcquisition({
        manifest,
        request: undefined,
        documentCount: 1,
      }),
    (error) =>
      error instanceof AgentTaskSourceAcquisitionInputError &&
      error.code === "source_acquisition_required",
  );
  assert.throws(
    () =>
      compileAgentTaskSourceAcquisition({
        manifest,
        request: {
          query: "ti=sensor",
          jurisdiction: "US",
          as_of_date: "2026-08-08",
          maximum_pages: 100,
        },
        documentCount: 1,
      }),
    (error) =>
      error instanceof AgentTaskSourceAcquisitionInputError &&
      error.code === "source_acquisition_invalid",
  );
  assert.throws(
    () =>
      compileAgentTaskSourceAcquisition({
        manifest: {
          input_contract: manifest.input_contract,
          source_acquisition: undefined,
        },
        request: {
          query: "ti=sensor",
          jurisdiction: "US",
          as_of_date: "2026-08-08",
        },
        documentCount: 1,
      }),
    (error) =>
      error instanceof AgentTaskSourceAcquisitionInputError &&
      error.code === "source_acquisition_unexpected",
  );
});

test("rejects jurisdiction and date scope outside the fixed EPO pin", () => {
  for (const request of [
    {
      query: "ti=sensor",
      jurisdiction: "ZZ",
      as_of_date: "2026-08-08",
    },
    {
      query: "ti=sensor",
      jurisdiction: "US",
      as_of_date: "2026-02-31",
    },
  ]) {
    assert.throws(
      () =>
        compileAgentTaskSourceAcquisition({
          manifest,
          request,
          documentCount: 1,
        }),
      (error) =>
        error instanceof AgentTaskSourceAcquisitionInputError &&
        error.code === "source_acquisition_invalid",
    );
  }
});
