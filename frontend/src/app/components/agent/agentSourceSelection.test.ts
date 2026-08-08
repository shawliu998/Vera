import assert from "node:assert/strict";
import test from "node:test";

import { getAgentSourceSelection } from "./agentSourceSelection";

function checkpoint() {
  return {
    step_id: "step-1",
    iteration: 1,
    summary: "Choose exact publications.",
    created_at: "2026-08-08T00:00:00.000Z",
    source_acquisition: {
      schema_version: "provider_source_acquisition_state_v1",
      phase: "selection_required",
      spec: {
        schema_version: "provider_source_acquisition_spec_v1",
        maximum_selections: 10,
      },
      discoveries: [
        {
          schema_version: "read_only_source_discovery_v1",
          discovery_ref: "epo-ops:publication:US7654321A1",
          external_id: "publication:US7654321A1",
          title: "Optical sensor publication",
          canonical_url:
            "https://worldwide.espacenet.com/patent/search?q=pn%3DUS7654321A1",
          published_on: "2025-01-01",
        },
      ],
    },
  };
}

test("reads only an exact bounded source-selection checkpoint", () => {
  assert.deepEqual(getAgentSourceSelection(checkpoint()), {
    maximumSelections: 10,
    discoveries: [
      {
        discoveryRef: "epo-ops:publication:US7654321A1",
        externalId: "publication:US7654321A1",
        title: "Optical sensor publication",
        canonicalUrl:
          "https://worldwide.espacenet.com/patent/search?q=pn%3DUS7654321A1",
        publishedOn: "2025-01-01",
      },
    ],
  });
});

test("fails closed for a malformed phase, duplicate ref or non-HTTPS source", () => {
  const wrongPhase = checkpoint();
  wrongPhase.source_acquisition.phase = "read_pending";
  assert.equal(getAgentSourceSelection(wrongPhase), null);

  const duplicate = checkpoint();
  duplicate.source_acquisition.discoveries.push(
    structuredClone(duplicate.source_acquisition.discoveries[0]!),
  );
  assert.equal(getAgentSourceSelection(duplicate), null);

  const unsafe = checkpoint();
  unsafe.source_acquisition.discoveries[0]!.canonical_url =
    "http://example.com/publication";
  assert.equal(getAgentSourceSelection(unsafe), null);
});
