import assert from "node:assert/strict";

import { resolveAgentStepCapabilityGrant } from "../src/lib/agent-kernel/capability/stepCapability";
import {
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  READ_ONLY_SOURCE_REQUEST_VERSION,
} from "../src/lib/agent-kernel/connectors/readOnlySourceContract";
import type { AgentStepContractV1 } from "../src/lib/agent-kernel/contracts/stepContract";
import {
  EPO_OPS_SOURCE_CONNECTOR_PIN,
  createEpoOpsSourceInvoker,
  createEpoOpsSourceNormalizer,
  type EpoOpsSourcePrimitivesV1,
} from "../src/lib/agent-packs/patent/epoOpsSourcePack";
import { executeProviderSourcePipeline } from "../src/lib/providerSourcePipeline";
import { createServerSupabase } from "../src/lib/supabase";
import { deleteFile, downloadFile } from "../src/lib/storage";

const userId = process.env.SMOKE_USER_ID?.trim();
const matterId = process.env.SMOKE_MATTER_ID?.trim();
if (!userId || !matterId) {
  throw new Error("SMOKE_USER_ID and SMOKE_MATTER_ID are required");
}

const now = new Date().toISOString();
const runRef = `epo-pipeline-${process.pid}-${Date.now()}`;
const documentNumber = String(Date.now()).slice(-10);
const publicationNumber = `US${documentNumber}A1`;
const claimText = `A deterministic fixture claim for ${runRef}.`;
const biblioXml = `<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:ex="http://www.epo.org/exchange"><ops:biblio-search total-result-count="1"><ex:exchange-document country="US" doc-number="${documentNumber}" kind="A1"><ex:bibliographic-data><ex:publication-reference><ex:document-id document-id-type="docdb"><ex:country>US</ex:country><ex:doc-number>${documentNumber}</ex:doc-number><ex:kind>A1</ex:kind><ex:date>20250101</ex:date></ex:document-id></ex:publication-reference><ex:invention-title lang="en">EPO pipeline smoke fixture</ex:invention-title></ex:bibliographic-data></ex:exchange-document></ops:biblio-search></ops:world-patent-data>`;
const claimsXml = `<ft:fulltext-documents xmlns:ft="http://www.epo.org/fulltext"><ft:claim><ft:claim-text>${claimText}</ft:claim-text></ft:claim></ft:fulltext-documents>`;

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
  async getAccessToken({ credentials }) {
    assert.equal(credentials.consumerKey, "smoke-key");
    assert.equal(credentials.consumerSecret, "smoke-secret");
    return { accessToken: "smoke-access-token", expiresInSeconds: 3_600 };
  },
  async searchBiblio() {
    return biblioXml;
  },
  async readBiblio({ publicationNumber: selected }) {
    assert.equal(selected, publicationNumber);
    return biblioXml;
  },
  async readFullText({ publicationNumber: selected }) {
    assert.equal(selected, publicationNumber);
    return { descriptionXml: null, claimsXml };
  },
};

function execution() {
  return {
    context: {
      taskId: runRef,
      stepId: `${runRef}-step`,
      stepPosition: 0,
      attempt: 1,
      matterId,
      sourceVersionIds: [],
    },
    grant,
    pin: EPO_OPS_SOURCE_CONNECTOR_PIN,
    authorization: {
      schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
      connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
      connection: "connected" as const,
      subscription: "verified" as const,
      checked_at: now,
    },
    request: {
      schema_version: READ_ONLY_SOURCE_REQUEST_VERSION,
      request_ref: `${runRef}-read`,
      operation: "read_snapshot" as const,
      query: null,
      external_id: `publication:${publicationNumber}`,
      jurisdiction: "US",
      as_of_date: "2025-01-02",
      page: null,
      page_size: null,
    },
    invoker: createEpoOpsSourceInvoker({
      operation: "read_snapshot",
      credentials: {
        consumerKey: "smoke-key",
        consumerSecret: "smoke-secret",
      },
      primitives,
    }),
    normalizer: createEpoOpsSourceNormalizer({ now: () => now }),
    now: () => now,
  };
}

async function main() {
  const db = createServerSupabase();
  let documentId: string | null = null;
  const storagePaths = new Set<string>();
  try {
    const first = await executeProviderSourcePipeline({
      db,
      userId,
      matterId,
      execution: execution(),
    });
    assert.equal(first.kind, "completed");
    if (first.kind !== "completed" || first.operation !== "read_snapshot") {
      throw new Error("epo_pipeline_did_not_complete_read");
    }
    assert.equal(first.imports.length, 1);
    assert.equal(first.imports[0]?.created, true);
    documentId = first.imports[0]!.document_id;

    const replay = await executeProviderSourcePipeline({
      db,
      userId,
      matterId,
      execution: execution(),
    });
    assert.equal(replay.kind, "completed");
    if (replay.kind !== "completed" || replay.operation !== "read_snapshot") {
      throw new Error("epo_pipeline_replay_did_not_complete_read");
    }
    assert.equal(replay.imports[0]?.created, false);
    assert.equal(replay.imports[0]?.document_id, documentId);
    assert.equal("importCandidates" in first, false);
    assert.equal(JSON.stringify(first).includes(claimText), false);

    const { data: version, error: versionError } = await db
      .from("document_versions")
      .select("storage_path,source,provider_source")
      .eq("id", first.imports[0]!.version_id)
      .single();
    if (versionError) throw new Error(versionError.message);
    assert.equal(version.source, "provider_import");
    assert.equal(version.provider_source.provider_id, "epo-ops");
    assert.equal(version.provider_source.external_id, `publication:${publicationNumber}`);
    assert.equal(Object.hasOwn(version.provider_source, "source_body"), false);
    storagePaths.add(version.storage_path);
    const stored = await downloadFile(version.storage_path);
    assert.match(
      Buffer.from(stored ?? new ArrayBuffer(0)).toString("utf8"),
      new RegExp(runRef),
    );

    console.log(
      JSON.stringify({
        ok: true,
        suite: "epo-ops-source-pipeline-db-smoke-v1",
        first_created: first.imports[0]?.created,
        replay_created: replay.imports[0]?.created,
        source: version.source,
        provider_id: version.provider_source.provider_id,
      }),
    );
  } finally {
    if (documentId) {
      const { data: versions } = await db
        .from("document_versions")
        .select("storage_path,pdf_storage_path")
        .eq("document_id", documentId);
      for (const version of versions ?? []) {
        if (typeof version.storage_path === "string") {
          storagePaths.add(version.storage_path);
        }
        if (typeof version.pdf_storage_path === "string") {
          storagePaths.add(version.pdf_storage_path);
        }
      }
      await db.from("documents").delete().eq("id", documentId);
    }
    for (const path of storagePaths) {
      await deleteFile(path).catch(() => undefined);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
