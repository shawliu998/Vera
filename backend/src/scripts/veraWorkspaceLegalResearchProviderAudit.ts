import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION,
  LegalResearchProviderStatusSchema,
  LegalResearchProviderTransportSchema,
  UNAVAILABLE_LEGAL_RESEARCH_PROVIDER_ID,
  WorkspaceLegalResearchProviderRegistry,
  type LegalResearchProvider,
} from "../lib/workspace/services/legalResearchProvider";
import {
  BoundedInMemoryLegalResearchSessionOwnership,
  LegalResearchToolError,
  WorkspaceLegalResearchTools,
  type LegalResearchSessionOwnershipPort,
  type LegalResearchSourceCapturePort,
  type LegalResearchToolContext,
  type OwnedLegalSourceReference,
} from "../lib/workspace/services/legalResearchTools";
import {
  createDeterministicFakeLegalResearchProvider,
  DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID,
} from "../lib/workspace/services/testing/deterministicFakeLegalResearchProvider";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";

function context(
  researchSessionId = "research-session-1",
): LegalResearchToolContext {
  return {
    projectId: PROJECT_ID,
    researchSessionId,
    modelExecution: "remote",
  };
}

function providerContext(researchSessionId = "research-session-1") {
  return {
    projectId: PROJECT_ID,
    researchSessionId,
  };
}

class InMemoryOwnership implements LegalResearchSessionOwnershipPort {
  private readonly records = new Map<string, OwnedLegalSourceReference>();

  private key(input: { context: LegalResearchToolContext; sourceRef: string }) {
    return `${input.context.projectId}\0${input.context.researchSessionId}\0${input.sourceRef}`;
  }

  async recordSearch(
    input: Parameters<LegalResearchSessionOwnershipPort["recordSearch"]>[0],
  ) {
    return input.results.map((result, index) => {
      const reference = {
        sourceRef: `owned:${input.queryId}:${index}`,
        providerId: input.providerId,
        providerSourceId: result.providerSourceId,
        queryId: input.queryId,
        durable: !input.transient,
        ...(!input.transient ? { readId: randomUUID() } : {}),
      } satisfies OwnedLegalSourceReference;
      this.records.set(
        this.key({ context: input.context, sourceRef: reference.sourceRef }),
        reference,
      );
      return reference;
    });
  }

  async resolveOwnedSource(
    input: Parameters<
      LegalResearchSessionOwnershipPort["resolveOwnedSource"]
    >[0],
  ) {
    return this.records.get(this.key(input)) ?? null;
  }
}

function capturePort(): LegalResearchSourceCapturePort {
  return {
    async capture(input) {
      assert.equal(input.context.projectId, PROJECT_ID);
      assert.equal(input.dataUsePolicy.basis, "deployment_contract");
      return {
        snapshotId: SNAPSHOT_ID,
        excerpts: [
          {
            anchorCandidateId: `anchor:${input.sourceRef}`,
            text: input.document.content,
            locator: input.document.locator,
          },
        ],
      };
    },
  };
}

async function assertProductionDefaultsTruthful() {
  assert.equal(
    LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION,
    "vera-workspace-legal-research-provider-v1",
  );
  const registry = WorkspaceLegalResearchProviderRegistry.production();
  assert.deepEqual(registry.providerIds(), [
    UNAVAILABLE_LEGAL_RESEARCH_PROVIDER_ID,
  ]);
  assert.ok(
    !registry
      .providerIds()
      .includes(DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID),
  );
  const status = await registry.status(
    UNAVAILABLE_LEGAL_RESEARCH_PROVIDER_ID,
    providerContext(),
  );
  assert.equal(status.state, "activation_gate_closed");
  assert.equal(status.canSearch, false);
  assert.equal(status.canFetchSource, false);
  const tools = new WorkspaceLegalResearchTools(
    UNAVAILABLE_LEGAL_RESEARCH_PROVIDER_ID,
    registry,
    new InMemoryOwnership(),
    capturePort(),
  );
  assert.deepEqual(await tools.registeredTools(context()), []);
}

async function assertConfiguredUnverifiedIsNotReady() {
  let providerCalled = false;
  const provider = createDeterministicFakeLegalResearchProvider({
    testingOnly: true,
    state: "configured_unverified",
    onSignal() {
      providerCalled = true;
    },
  });
  const registry = WorkspaceLegalResearchProviderRegistry.forTesting([
    provider,
  ]);
  const status = await registry.status(provider.id, providerContext());
  assert.equal(status.state, "configured_unverified");
  assert.equal(status.connectionVerified, false);
  await assert.rejects(
    registry.search({
      providerId: provider.id,
      context: providerContext(),
      request: { query: "fixture", limit: 1 },
      signal: new AbortController().signal,
    }),
    /tool use is unavailable \(configured_unverified\)/i,
  );
  assert.equal(providerCalled, false);
}

async function assertFakeIsolationAndSignalForwarding() {
  let observedSignal: AbortSignal | null = null;
  const provider = createDeterministicFakeLegalResearchProvider({
    testingOnly: true,
    onSignal(signal) {
      observedSignal = signal;
    },
  });
  assert.throws(
    () => WorkspaceLegalResearchProviderRegistry.production([provider]),
    /explicit test registry/i,
  );
  const registry = WorkspaceLegalResearchProviderRegistry.forTesting([
    provider,
  ]);
  const signal = new AbortController().signal;
  await registry.search({
    providerId: provider.id,
    context: providerContext(),
    request: { query: "fixture", limit: 1 },
    signal,
  });
  assert.equal(observedSignal, signal);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    registry.search({
      providerId: provider.id,
      context: providerContext(),
      request: { query: "fixture", limit: 1 },
      signal: cancelled.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
}

async function assertBoundedSearchAndOwnedRead() {
  const provider = createDeterministicFakeLegalResearchProvider({
    testingOnly: true,
  });
  const ownership = new InMemoryOwnership();
  const tools = new WorkspaceLegalResearchTools(
    provider.id,
    WorkspaceLegalResearchProviderRegistry.forTesting([provider]),
    ownership,
    capturePort(),
  );
  const signal = new AbortController().signal;
  const search = await tools.search({
    context: context(),
    rawInput: { query: "deterministic", limit: 2 },
    signal,
  });
  assert.equal(search.provider, provider.id);
  assert.equal(search.results.length, 2);
  assert.ok(search.results[0]?.sourceRef.startsWith("owned:"));
  const serializedSearch = JSON.stringify(search);
  assert.ok(!serializedSearch.includes("providerSourceId"));
  assert.ok(!serializedSearch.includes("Article 1"));

  const sourceRef = search.results[0]!.sourceRef;
  await assert.rejects(
    tools.read({
      context: context("different-session"),
      rawInput: { sourceRef },
      signal,
    }),
    (error: unknown) =>
      error instanceof LegalResearchToolError &&
      error.code === "legal_source_not_owned",
  );
  await assert.rejects(
    tools.read({
      context: context(),
      rawInput: { sourceRef: "https://example.invalid/arbitrary" },
      signal,
    }),
    /not owned by this Matter research session/i,
  );

  const read = await tools.read({
    context: context(),
    rawInput: { sourceRef },
    signal,
  });
  assert.equal(read.snapshotId, SNAPSHOT_ID);
  assert.equal(read.sourceRef, sourceRef);
  assert.equal(read.excerpts.length, 1);
}

async function assertRightsFailClosedBeforeFetch() {
  let transportCalls = 0;
  const base = createDeterministicFakeLegalResearchProvider({
    testingOnly: true,
    onSignal() {
      transportCalls += 1;
    },
  });
  const localOnly: LegalResearchProvider = {
    ...base,
    async status(providerContext) {
      const status = await base.status(providerContext);
      return {
        ...status,
        dataUsePolicy: { ...status.dataUsePolicy, modelUse: "local_only" },
      };
    },
  };
  const tools = new WorkspaceLegalResearchTools(
    localOnly.id,
    WorkspaceLegalResearchProviderRegistry.forTesting([localOnly]),
    new InMemoryOwnership(),
    capturePort(),
  );
  await assert.rejects(
    tools.search({
      context: context(),
      rawInput: { query: "fixture", limit: 1 },
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof LegalResearchToolError &&
      error.code === "legal_source_license_restricted",
  );
  assert.equal(transportCalls, 0);
}

async function assertExplicitTechnicalPocIsTransient() {
  let captures = 0;
  const base = createDeterministicFakeLegalResearchProvider({
    testingOnly: true,
  });
  const poc: LegalResearchProvider = {
    ...base,
    async status() {
      return {
        providerId: base.id,
        state: "configured_unverified",
        configured: true,
        connectionVerified: false,
        canSearch: false,
        canFetchSource: false,
        toolUseAllowed: true,
        technicalPoc: {
          enabled: true,
          environment: "test",
          connectionPassed: true,
          userAuthorized: true,
          durable: false,
        },
        reason: "Explicit user-authorized technical PoC; not production ready.",
        dataUsePolicy: {
          basis: "not_declared",
          retention: "not_declared",
          export: "not_declared",
          modelUse: "not_declared",
        },
      };
    },
  };
  const ownership = new BoundedInMemoryLegalResearchSessionOwnership();
  const tools = new WorkspaceLegalResearchTools(
    poc.id,
    WorkspaceLegalResearchProviderRegistry.forTesting([poc]),
    ownership,
    {
      async capture() {
        captures += 1;
        throw new Error("Technical PoC must not capture a durable source.");
      },
    },
  );
  assert.equal((await tools.registeredTools(context())).length, 2);
  const search = await tools.search({
    context: context(),
    rawInput: { query: "deterministic", limit: 1 },
    signal: new AbortController().signal,
  });
  assert.equal(search.durable, false);
  assert.match(search.results[0]!.sourceRef, /^[A-Za-z0-9_-]{32}$/);
  const read = await tools.read({
    context: context(),
    rawInput: { sourceRef: search.results[0]!.sourceRef },
    signal: new AbortController().signal,
  });
  assert.equal(read.durable, false);
  assert.equal(read.snapshotId, null);
  assert.equal(captures, 0);
}

async function assertBoundedSessionOwnership() {
  const ownership = new BoundedInMemoryLegalResearchSessionOwnership();
  const result = {
    providerSourceId: "provider-source",
    title: "Fixture",
    sourceType: "statute" as const,
  };
  let sourceRef = "";
  for (let index = 0; index < 4; index += 1) {
    const records = await ownership.recordSearch({
      context: context(),
      providerId: DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID,
      queryId: `query-${index}`,
      results: [result],
      transient: true,
    });
    sourceRef = records[0]!.sourceRef;
    assert.match(sourceRef, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(records[0]!.durable, false);
  }
  await assert.rejects(
    ownership.recordSearch({
      context: context(),
      providerId: DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID,
      queryId: "query-5",
      results: [result],
      transient: true,
    }),
    (error: unknown) =>
      error instanceof LegalResearchToolError &&
      error.code === "legal_research_limit_exceeded",
  );
  assert.equal(
    await ownership.resolveOwnedSource({
      context: context("other-session"),
      sourceRef,
    }),
    null,
  );
  for (let index = 0; index < 12; index += 1) {
    assert.ok(
      await ownership.resolveOwnedSource({ context: context(), sourceRef }),
    );
  }
  await assert.rejects(
    ownership.resolveOwnedSource({ context: context(), sourceRef }),
    (error: unknown) =>
      error instanceof LegalResearchToolError &&
      error.code === "legal_research_limit_exceeded",
  );
}

async function assertMcpConfigurationReferencesOnly() {
  const credentialRef =
    "keychain://vera/legal-provider/99999999-9999-4999-8999-999999999999/fixturelocator0001";
  assert.deepEqual(
    LegalResearchProviderTransportSchema.parse({
      kind: "mcp_https_stream",
      endpointRefs: [
        { capability: "law", endpointRef: "workspace:endpoint:law" },
        { capability: "case", endpointRef: "workspace:endpoint:case" },
        { capability: "company", endpointRef: "workspace:endpoint:company" },
      ],
      credentialRef,
    }).kind,
    "mcp_https_stream",
  );
  assert.throws(() =>
    LegalResearchProviderTransportSchema.parse({
      kind: "mcp_https_stream",
      endpointRefs: [
        { capability: "law", endpointRef: "https://secret.example/mcp" },
      ],
      credentialRef: "Bearer secret-value",
    }),
  );
  assert.throws(() =>
    LegalResearchProviderTransportSchema.parse({
      kind: "mcp_https_stream",
      endpointRefs: [
        { capability: "law", endpointRef: "workspace:endpoint:law" },
        { capability: "law", endpointRef: "workspace:endpoint:law-two" },
      ],
      credentialRef,
    }),
  );
}

async function assertStatusSchemaFailClosed() {
  assert.throws(() =>
    LegalResearchProviderStatusSchema.parse({
      providerId: "bad-provider",
      state: "configured_unverified",
      configured: true,
      connectionVerified: false,
      canSearch: true,
      canFetchSource: false,
      toolUseAllowed: false,
      technicalPoc: {
        enabled: false,
        environment: null,
        connectionPassed: false,
        userAuthorized: false,
        durable: false,
      },
      reason: null,
      dataUsePolicy: {
        basis: "not_declared",
        retention: "not_declared",
        export: "not_declared",
        modelUse: "not_declared",
      },
    }),
  );
}

async function main() {
  await assertProductionDefaultsTruthful();
  await assertConfiguredUnverifiedIsNotReady();
  await assertFakeIsolationAndSignalForwarding();
  await assertBoundedSearchAndOwnedRead();
  await assertRightsFailClosedBeforeFetch();
  await assertExplicitTechnicalPocIsTransient();
  await assertBoundedSessionOwnership();
  await assertMcpConfigurationReferencesOnly();
  await assertStatusSchemaFailClosed();
  console.log("Vera Workspace legal research provider audit passed.");
}

void main();
