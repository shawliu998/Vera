import assert from "node:assert/strict";
import test from "node:test";

import {
  AletheiaApiError,
  listAletheiaLegalSourceProviders,
  parseAletheiaLegalSourceProvider,
  parseAletheiaLegalSourceProvidersResponse,
  removeAletheiaLegalSourceSecret,
  saveAletheiaLegalSourceSecret,
} from "../src/app/lib/aletheiaApi.ts";

const TOKEN = "legal-source-client-audit-token";
const API_BASE = "http://127.0.0.1:43123";

function capabilities() {
  return {
    search: true,
    fetchFullText: true,
    pagination: false,
    getByCitation: false,
    jurisdictionFilter: false,
    asOfDateFilter: false,
    structuredFilters: false,
    dynamicToolInvocation: false,
    requiresExplicitEgressApproval: true,
    documentKinds: ["statute", "judicial_interpretation", "case", "other"],
  };
}

function dataUsePolicy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    basis: "not_declared",
    retention: "not_declared",
    export: "not_declared",
    modelUse: "not_declared",
    ...overrides,
  };
}

type ProviderOptions = {
  hasSecret?: boolean;
  encryptionEnabled?: boolean;
  endpointConfigured?: boolean;
  allowlisted?: boolean;
  credentialReferenceConfigured?: boolean;
  connectionStatus?: Record<string, unknown>;
  dataUsePolicy?: Record<string, unknown>;
};

function expectedReason(
  options: Required<
    Omit<ProviderOptions, "connectionStatus" | "dataUsePolicy">
  >,
) {
  if (!options.endpointConfigured) return "endpoint_missing";
  if (!options.allowlisted) return "endpoint_not_allowlisted";
  if (!options.credentialReferenceConfigured) {
    return "credential_reference_missing";
  }
  if (!options.encryptionEnabled) return "secret_storage_unavailable";
  if (!options.hasSecret) return "credential_unavailable";
  return null;
}

function provider(
  providerId: "pkulaw" | "wolters" = "pkulaw",
  input: ProviderOptions = {},
) {
  const options = {
    hasSecret: input.hasSecret ?? true,
    encryptionEnabled: input.encryptionEnabled ?? true,
    endpointConfigured: input.endpointConfigured ?? true,
    allowlisted: input.allowlisted ?? true,
    credentialReferenceConfigured: input.credentialReferenceConfigured ?? true,
  };
  const reason = expectedReason(options);
  return {
    provider: providerId,
    deploymentReady:
      options.endpointConfigured &&
      options.allowlisted &&
      options.credentialReferenceConfigured,
    ...options,
    contractVersion: "vera-legal-research-provider-v1",
    integration: "authorized_json_gateway",
    capabilities: capabilities(),
    dataUsePolicy: input.dataUsePolicy ?? dataUsePolicy(),
    connectionStatus:
      input.connectionStatus ??
      (reason
        ? { state: "unavailable", reason, connectionTested: false }
        : {
            state: "configured_unverified",
            reason: null,
            connectionTested: false,
          }),
  };
}

function closedGateProvider(
  providerId: "pkulaw" | "wolters" = "pkulaw",
  input: ProviderOptions = {},
) {
  return provider(providerId, {
    ...input,
    connectionStatus: {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    },
  });
}

function response() {
  return {
    schemaVersion: "vera-legal-source-provider-status-v1",
    localOnly: true,
    detail: "Authorized legal-source deployment and local credential status.",
    providers: [
      closedGateProvider("pkulaw"),
      closedGateProvider("wolters", { hasSecret: false }),
    ],
  };
}

function invalidResponse(error: unknown) {
  return (
    error instanceof AletheiaApiError &&
    error.status === 502 &&
    error.code === "INVALID_RESPONSE"
  );
}

test("legal-source parser preserves the complete truthful provider-neutral wire", () => {
  const parsed = parseAletheiaLegalSourceProvidersResponse(response());
  assert.equal(parsed.schemaVersion, "vera-legal-source-provider-status-v1");
  assert.equal(parsed.localOnly, true);
  assert.equal(parsed.providers.length, 2);
  assert.deepEqual(parsed.providers[0]?.connectionStatus, {
    state: "unavailable",
    reason: "activation_gate_closed",
    connectionTested: false,
  });
  assert.deepEqual(parsed.providers[1]?.connectionStatus, {
    state: "unavailable",
    reason: "activation_gate_closed",
    connectionTested: false,
  });
  assert.equal(parsed.providers[0]?.capabilities.search, true);

  const declaredPolicy = parseAletheiaLegalSourceProvider(
    provider("pkulaw", {
      dataUsePolicy: dataUsePolicy({
        basis: "deployment_contract",
        retention: "full_text_ttl",
        export: "exact_quotes_only",
        modelUse: "local_only",
      }),
    }),
  );
  assert.deepEqual(declaredPolicy.dataUsePolicy, {
    basis: "deployment_contract",
    retention: "full_text_ttl",
    export: "exact_quotes_only",
    modelUse: "local_only",
  });

  for (const fixture of [
    provider("pkulaw", {
      endpointConfigured: false,
      allowlisted: false,
    }),
    provider("pkulaw", { allowlisted: false }),
    provider("pkulaw", { credentialReferenceConfigured: false }),
    provider("pkulaw", { hasSecret: false }),
    provider("pkulaw", { encryptionEnabled: false }),
    provider("pkulaw", {
      connectionStatus: {
        state: "unavailable",
        reason: "secret_storage_unavailable",
        connectionTested: false,
      },
    }),
  ]) {
    assert.equal(
      parseAletheiaLegalSourceProvider(fixture).connectionStatus.state,
      "unavailable",
    );
  }
});

test("legal-source parser preserves the backend closed-gate precedence before credential state", () => {
  for (const fixture of [
    closedGateProvider("pkulaw", { hasSecret: false }),
    closedGateProvider("pkulaw", { encryptionEnabled: false }),
    closedGateProvider("pkulaw", {
      hasSecret: false,
      encryptionEnabled: false,
    }),
  ]) {
    assert.deepEqual(
      parseAletheiaLegalSourceProvider(fixture).connectionStatus,
      {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      },
    );
  }

  assert.throws(
    () =>
      parseAletheiaLegalSourceProvider(
        closedGateProvider("pkulaw", {
          endpointConfigured: false,
          allowlisted: false,
        }),
      ),
    invalidResponse,
  );
});

test("legal-source parser rejects leaks, unknown providers, and contradictory legacy test states", () => {
  for (const sensitiveField of [
    "secret",
    "credentialRef",
    "credentialReference",
    "endpoint",
    "path",
    "encryptedSecret",
    "lastTestStatus",
    "lastTestAt",
    "internalOnly",
  ]) {
    assert.throws(
      () =>
        parseAletheiaLegalSourceProvider({
          ...provider(),
          [sensitiveField]: "must-not-cross-wire",
        }),
      invalidResponse,
      sensitiveField,
    );
  }

  const poisonedTop = response() as Record<string, unknown>;
  poisonedTop.credentialReferences = ["must-not-cross-wire"];
  assert.throws(
    () => parseAletheiaLegalSourceProvidersResponse(poisonedTop),
    invalidResponse,
  );
  assert.throws(
    () =>
      parseAletheiaLegalSourceProvidersResponse({
        ...response(),
        providers: [
          provider("pkulaw"),
          { ...provider("wolters"), provider: "unknown" },
        ],
      }),
    invalidResponse,
  );

  for (const contradictory of [
    { ...provider(), deploymentReady: false },
    {
      ...provider(),
      hasSecret: false,
      connectionStatus: {
        state: "configured_unverified",
        reason: null,
        connectionTested: false,
      },
    },
    {
      ...provider(),
      connectionStatus: {
        state: "configured_unverified",
        reason: null,
        connectionTested: true,
      },
    },
    {
      ...provider(),
      connectionStatus: {
        state: "unavailable",
        reason: "connection_test_failed",
        connectionTested: true,
      },
    },
    {
      ...provider(),
      endpointConfigured: false,
      allowlisted: true,
      deploymentReady: false,
      connectionStatus: {
        state: "unavailable",
        reason: "endpoint_missing",
        connectionTested: false,
      },
    },
    {
      ...provider("pkulaw", { hasSecret: false }),
      connectionStatus: {
        state: "unavailable",
        reason: "secret_storage_unavailable",
        connectionTested: false,
      },
    },
  ]) {
    assert.throws(
      () => parseAletheiaLegalSourceProvider(contradictory),
      invalidResponse,
    );
  }
});

function installDesktop() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { backendUrl: API_BASE };
        },
        async getAuthToken() {
          return TOKEN;
        },
      },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("legal-source API authenticates list/save/remove and never returns or accepts leaked secrets", async () => {
  const restoreWindow = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue: Array<{ status: number; body?: unknown }> = [
    { status: 200, body: response() },
    { status: 200, body: closedGateProvider("pkulaw") },
    { status: 204 },
    {
      status: 200,
      body: { ...provider("pkulaw"), secret: "server-leak" },
    },
  ];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    assert(next);
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      {
        status: next.status,
        headers:
          next.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const listed = await listAletheiaLegalSourceProviders();
    assert.equal(listed.providers.length, 2);
    const secret = "client-secret-sent-once";
    assert.equal(
      await saveAletheiaLegalSourceSecret("pkulaw", secret),
      undefined,
    );
    await removeAletheiaLegalSourceSecret("pkulaw");
    await assert.rejects(
      () => saveAletheiaLegalSourceSecret("pkulaw", "second-secret"),
      invalidResponse,
    );

    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(
        new Headers(call.init?.headers).get("authorization"),
        `Bearer ${TOKEN}`,
      );
      assert.equal(call.init?.cache, "no-store");
    }
    assert.equal(calls[0]?.url, `${API_BASE}/aletheia/providers`);
    assert.equal(calls[0]?.init?.method, undefined);
    assert.equal(calls[1]?.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { secret });
    assert.equal(calls[2]?.init?.method, "DELETE");
    assert.equal(calls[3]?.init?.method, "PUT");
  } finally {
    globalThis.fetch = originalFetch;
    restoreWindow();
  }
});
