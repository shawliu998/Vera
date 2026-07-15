import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LegalSourceAdapterError } from "../lib/aletheia/legalSourceAdapter";
import {
  createOfficialPublicLegalResearchProvider,
  createOfficialPublicLegalResearchProviderFromEnvironment,
  createPkulawLegalResearchProvider,
  createPkulawLegalResearchProviderFromEnvironment,
  createWoltersLegalResearchProvider,
  createWoltersLegalResearchProviderFromEnvironment,
  createYuanDianLegalResearchProviderFromEnvironment,
  hasDeclaredDeploymentDataUsePolicy,
  legalResearchProviderDeploymentStatus,
  legalResearchProviderDescriptorFromEnvironment,
  projectLegalResearchProviderConnectionStatus,
} from "../lib/aletheia/legalResearchProvider";

const endpoint = "https://api.pkulaw.example/v1/legal";
const credentialRef = "PKULAW_OFFICIAL_API";
const declaredDataUsePolicy = {
  basis: "deployment_contract",
  retention: "full_text_permitted",
  export: "exact_quotes_only",
  modelUse: "local_only",
} as const;

function config() {
  return {
    endpoint,
    allowedHosts: ["pkulaw.example"],
    credentialRef,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function adapterError(code: LegalSourceAdapterError["code"]) {
  return (error: unknown) =>
    error instanceof LegalSourceAdapterError && error.code === code;
}

const environmentKeys = [
  "VERA_PKULAW_API_ENDPOINT",
  "VERA_PKULAW_API_ALLOWED_HOSTS",
  "VERA_PKULAW_API_CREDENTIAL_REF",
  "VERA_YUANDIAN_API_ENDPOINT",
  "VERA_YUANDIAN_API_ALLOWED_HOSTS",
  "VERA_YUANDIAN_API_CREDENTIAL_REF",
  "VERA_WOLTERS_API_ENDPOINT",
  "VERA_WOLTERS_API_ALLOWED_HOSTS",
  "VERA_WOLTERS_API_CREDENTIAL_REF",
  "VERA_OFFICIAL_LEGAL_API_ENDPOINT",
  "VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS",
] as const;

type EnvironmentKey = (typeof environmentKeys)[number];
type EnvironmentSnapshot = ReadonlyMap<
  EnvironmentKey,
  Readonly<{ present: boolean; value: string | undefined }>
>;

function snapshotEnvironment(): EnvironmentSnapshot {
  return new Map(
    environmentKeys.map(
      (key) =>
        [
          key,
          {
            present: Object.prototype.hasOwnProperty.call(process.env, key),
            value: process.env[key],
          },
        ] as const,
    ),
  );
}

function restoreEnvironment(saved: EnvironmentSnapshot) {
  for (const key of environmentKeys) {
    const entry = saved.get(key);
    assert.ok(entry);
    if (!entry.present) delete process.env[key];
    else {
      assert.notEqual(entry.value, undefined);
      process.env[key] = entry.value;
    }
  }
}

function assertEnvironmentRestored(saved: EnvironmentSnapshot) {
  for (const key of environmentKeys) {
    const entry = saved.get(key);
    assert.ok(entry);
    assert.equal(
      Object.prototype.hasOwnProperty.call(process.env, key),
      entry.present,
    );
    assert.equal(process.env[key], entry.value);
  }
}

async function main() {
  assert.equal(hasDeclaredDeploymentDataUsePolicy(declaredDataUsePolicy), true);
  for (const incompletePolicy of [
    {
      ...declaredDataUsePolicy,
      basis: "not_declared" as const,
    },
    { ...declaredDataUsePolicy, retention: "not_declared" as const },
    { ...declaredDataUsePolicy, export: "not_declared" as const },
    { ...declaredDataUsePolicy, modelUse: "not_declared" as const },
  ]) {
    assert.equal(hasDeclaredDeploymentDataUsePolicy(incompletePolicy), false);
  }

  const requests: Array<Record<string, string>> = [];
  const provider = createPkulawLegalResearchProvider(
    config(),
    {
      now: () => new Date("2026-07-15T08:00:00.000Z"),
      resolveCredential: async (reference) => {
        assert.equal(reference, credentialRef);
        return "audit-only-credential";
      },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        requests.push(body);
        return body.operation === "search"
          ? jsonResponse({
              results: [
                {
                  id: "civil-code-509",
                  title: "Civil Code Article 509",
                  summary: "Performance must follow the agreement.",
                  url: "https://www.api.pkulaw.example/documents/civil-code-509",
                  effectiveDate: "2021-01-01",
                  documentKind: "statute",
                },
              ],
            })
          : jsonResponse({
              document: {
                id: "civil-code-509",
                title: "Civil Code Article 509",
                content:
                  "Parties shall fully perform their obligations as agreed.",
                url: "https://www.api.pkulaw.example/documents/civil-code-509",
                effectiveDate: "2021-01-01",
                documentKind: "statute",
              },
            });
      },
    },
    {
      dataUsePolicy: {
        basis: "deployment_contract",
        retention: "metadata_only",
        export: "exact_quotes_only",
        modelUse: "local_only",
      },
    },
  );

  assert.equal(provider.contractVersion, "vera-legal-research-provider-v2");
  assert.equal(provider.integration, "authorized_provider_adapter");
  assert.deepEqual(provider.capabilities, {
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
  });
  assert.deepEqual(provider.dataUsePolicy, {
    basis: "deployment_contract",
    retention: "metadata_only",
    export: "exact_quotes_only",
    modelUse: "local_only",
  });
  assert.deepEqual(await provider.connectionStatus(), {
    state: "configured_unverified",
    reason: null,
    connectionTested: false,
  });

  const serialized = JSON.stringify(provider);
  assert.equal(serialized.includes(endpoint), false);
  assert.equal(serialized.includes(credentialRef), false);
  assert.equal(serialized.includes("audit-only-credential"), false);

  const results = await provider.search({ query: "contract performance" });
  assert.equal(results[0]?.documentId, "civil-code-509");
  assert.equal(results[0]?.snapshot.sourceType, "pkulaw");
  const document = await provider.fetch({ documentId: "civil-code-509" });
  assert.equal(document.documentId, "civil-code-509");
  assert.equal(document.snapshot.sourceType, "pkulaw");
  assert.deepEqual(requests, [
    { operation: "search", query: "contract performance" },
    { operation: "fetch", documentId: "civil-code-509" },
  ]);

  const savedPkulawModes = snapshotEnvironment();
  let modeCredentialReads = 0;
  let modeFetches = 0;
  const modeDependencies = {
    resolveCredential: async () => {
      modeCredentialReads += 1;
      return "must-not-be-read-while-activation-gate-is-closed";
    },
    fetch: async () => {
      modeFetches += 1;
      return jsonResponse({ results: [] });
    },
  };
  try {
    process.env.VERA_PKULAW_API_ENDPOINT =
      "https://apim-gw.pkulaw.com/vera_law_semantic_01/mcp";
    process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "apim-gw.pkulaw.com";
    process.env.VERA_PKULAW_API_CREDENTIAL_REF = "PKULAW_MCP_GATE_AUDIT";

    assert.deepEqual(legalResearchProviderDeploymentStatus("pkulaw"), {
      endpointConfigured: true,
      allowlisted: true,
      credentialReferenceConfigured: true,
    });
    assert.equal(
      legalResearchProviderDescriptorFromEnvironment("pkulaw").capabilities
        .fetchFullText,
      false,
    );
    assert.deepEqual(
      legalResearchProviderDescriptorFromEnvironment("pkulaw").capabilities
        .documentKinds,
      ["statute", "judicial_interpretation", "other"],
    );
    const mcpEnvironmentProvider =
      createPkulawLegalResearchProviderFromEnvironment(modeDependencies);
    assert.equal(mcpEnvironmentProvider.capabilities.fetchFullText, false);
    assert.deepEqual(mcpEnvironmentProvider.capabilities.documentKinds, [
      "statute",
      "judicial_interpretation",
      "other",
    ]);
    assert.deepEqual(await mcpEnvironmentProvider.connectionStatus(), {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    });
    await assert.rejects(
      () => mcpEnvironmentProvider.search({ query: "MCP gate audit" }),
      adapterError("configuration_error"),
    );
    const declaredMcpEnvironmentProvider =
      createPkulawLegalResearchProviderFromEnvironment(modeDependencies, {
        dataUsePolicy: declaredDataUsePolicy,
      });
    assert.deepEqual(
      await declaredMcpEnvironmentProvider.connectionStatus(),
      {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      },
      "the code-owned activation gate must remain higher priority than a declared policy",
    );
    await assert.rejects(
      () =>
        mcpEnvironmentProvider.fetch({
          documentId: "pkulaw:mcp:" + "a".repeat(64),
        }),
      adapterError("configuration_error"),
    );

    process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "pkulaw.com";
    assert.deepEqual(legalResearchProviderDeploymentStatus("pkulaw"), {
      endpointConfigured: true,
      allowlisted: false,
      credentialReferenceConfigured: true,
    });

    process.env.VERA_PKULAW_API_ENDPOINT =
      "https://apim-gateway.pkulaw.com/mcp-case-search-service";
    process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "apim-gateway.pkulaw.com";
    const invalidMcpProvider =
      createPkulawLegalResearchProviderFromEnvironment(modeDependencies);
    assert.equal(invalidMcpProvider.capabilities.fetchFullText, false);
    assert.deepEqual(await invalidMcpProvider.connectionStatus(), {
      state: "unavailable",
      reason: "endpoint_not_allowlisted",
      connectionTested: false,
    });

    process.env.VERA_PKULAW_API_ENDPOINT =
      "https://api.pkulaw.example/v1/legal";
    process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "pkulaw.example";
    assert.equal(
      legalResearchProviderDescriptorFromEnvironment("pkulaw").capabilities
        .fetchFullText,
      true,
    );
    assert.deepEqual(
      legalResearchProviderDescriptorFromEnvironment("pkulaw").capabilities
        .documentKinds,
      ["statute", "judicial_interpretation", "case", "other"],
    );
    const jsonEnvironmentProvider =
      createPkulawLegalResearchProviderFromEnvironment(modeDependencies);
    assert.equal(jsonEnvironmentProvider.capabilities.fetchFullText, true);
    assert.deepEqual(await jsonEnvironmentProvider.connectionStatus(), {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    });
    assert.equal(modeCredentialReads, 0);
    assert.equal(modeFetches, 0);
  } finally {
    restoreEnvironment(savedPkulawModes);
  }
  assertEnvironmentRestored(savedPkulawModes);

  let officialAuthorization: string | null = null;
  const configuredOfficial = createOfficialPublicLegalResearchProvider(
    {
      endpoint: "https://api.official.example/v1/legal",
      allowedHosts: ["official.example"],
    },
    {
      fetch: async (_input, init) => {
        officialAuthorization = new Headers(init?.headers).get("authorization");
        return jsonResponse({ results: [] });
      },
    },
  );
  assert.equal(configuredOfficial.provider, "official");
  assert.deepEqual(await configuredOfficial.connectionStatus(), {
    state: "configured_unverified",
    reason: null,
    connectionTested: false,
  });
  assert.deepEqual(
    await configuredOfficial.search({ query: "civil code" }),
    [],
  );
  assert.equal(officialAuthorization, null);

  const missingCredential = createWoltersLegalResearchProvider(
    {
      ...config(),
      endpoint: "https://api.wolters.example/v1/legal",
      allowedHosts: ["wolters.example"],
    },
    { resolveCredential: async () => undefined },
  );
  assert.deepEqual(await missingCredential.connectionStatus(), {
    state: "unavailable",
    reason: "credential_unavailable",
    connectionTested: false,
  });
  assert.deepEqual(missingCredential.dataUsePolicy, {
    basis: "not_declared",
    retention: "not_declared",
    export: "not_declared",
    modelUse: "not_declared",
  });
  await assert.rejects(
    () => missingCredential.search({ query: "contract" }),
    adapterError("credential_unavailable"),
  );

  const savedPkulawEndpoint = process.env.VERA_PKULAW_API_ENDPOINT;
  const savedPkulawHosts = process.env.VERA_PKULAW_API_ALLOWED_HOSTS;
  const savedPkulawCredentialRef = process.env.VERA_PKULAW_API_CREDENTIAL_REF;
  delete process.env.VERA_PKULAW_API_ENDPOINT;
  delete process.env.VERA_PKULAW_API_ALLOWED_HOSTS;
  process.env.VERA_PKULAW_API_CREDENTIAL_REF = "configured-but-not-readable";
  let credentialReadAttempted = false;
  try {
    const unavailablePkulaw = createPkulawLegalResearchProviderFromEnvironment({
      resolveCredential: async () => {
        credentialReadAttempted = true;
        return "must-not-be-read";
      },
    });
    assert.deepEqual(await unavailablePkulaw.connectionStatus(), {
      state: "unavailable",
      reason: "endpoint_missing",
      connectionTested: false,
    });
    assert.equal(credentialReadAttempted, false);
  } finally {
    if (savedPkulawEndpoint === undefined)
      delete process.env.VERA_PKULAW_API_ENDPOINT;
    else process.env.VERA_PKULAW_API_ENDPOINT = savedPkulawEndpoint;
    if (savedPkulawHosts === undefined)
      delete process.env.VERA_PKULAW_API_ALLOWED_HOSTS;
    else process.env.VERA_PKULAW_API_ALLOWED_HOSTS = savedPkulawHosts;
    if (savedPkulawCredentialRef === undefined)
      delete process.env.VERA_PKULAW_API_CREDENTIAL_REF;
    else process.env.VERA_PKULAW_API_CREDENTIAL_REF = savedPkulawCredentialRef;
  }

  const savedEndpoint = process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
  const savedHosts = process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS;
  delete process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
  delete process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS;
  try {
    const official = createOfficialPublicLegalResearchProviderFromEnvironment();
    assert.deepEqual(await official.connectionStatus(), {
      state: "unavailable",
      reason: "endpoint_missing",
      connectionTested: false,
    });
    await assert.rejects(
      () => official.search({ query: "civil code" }),
      adapterError("configuration_error"),
    );
  } finally {
    if (savedEndpoint === undefined)
      delete process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
    else process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT = savedEndpoint;
    if (savedHosts === undefined)
      delete process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS;
    else process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS = savedHosts;
  }

  const savedConfiguredEnvironment = snapshotEnvironment();
  let environmentCredentialReads = 0;
  let environmentFetches = 0;
  try {
    process.env.VERA_PKULAW_API_ENDPOINT =
      "https://api.pkulaw.example/v1/legal";
    process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "pkulaw.example";
    process.env.VERA_PKULAW_API_CREDENTIAL_REF = "PKULAW_GATE_AUDIT";
    process.env.VERA_YUANDIAN_API_ENDPOINT = "https://open.chineselaw.com";
    process.env.VERA_YUANDIAN_API_ALLOWED_HOSTS = "open.chineselaw.com";
    process.env.VERA_YUANDIAN_API_CREDENTIAL_REF = "YUANDIAN_GATE_AUDIT";
    process.env.VERA_WOLTERS_API_ENDPOINT =
      "https://api.wolters.example/v1/legal";
    process.env.VERA_WOLTERS_API_ALLOWED_HOSTS = "wolters.example";
    process.env.VERA_WOLTERS_API_CREDENTIAL_REF = "WOLTERS_GATE_AUDIT";
    process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT =
      "https://api.official.example/v1/legal";
    process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS = "official.example";

    const environmentDependencies = {
      resolveCredential: async () => {
        environmentCredentialReads += 1;
        return "must-not-be-read-while-activation-gate-is-closed";
      },
      fetch: async () => {
        environmentFetches += 1;
        return jsonResponse({ results: [] });
      },
    };
    const environmentProviders = [
      createPkulawLegalResearchProviderFromEnvironment(environmentDependencies),
      createYuanDianLegalResearchProviderFromEnvironment(
        environmentDependencies,
      ),
      createWoltersLegalResearchProviderFromEnvironment(
        environmentDependencies,
      ),
      createOfficialPublicLegalResearchProviderFromEnvironment(
        environmentDependencies,
      ),
    ];
    for (const environmentProvider of environmentProviders) {
      assert.deepEqual(await environmentProvider.connectionStatus(), {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });
      await assert.rejects(
        () => environmentProvider.search({ query: "activation gate audit" }),
        adapterError("configuration_error"),
      );
      await assert.rejects(
        () => environmentProvider.fetch({ documentId: "gate-audit-document" }),
        adapterError("configuration_error"),
      );
    }
    assert.equal(environmentCredentialReads, 0);
    assert.equal(environmentFetches, 0);
  } finally {
    restoreEnvironment(savedConfiguredEnvironment);
  }
  assertEnvironmentRestored(savedConfiguredEnvironment);

  const legalResearchRouteSource = readFileSync(
    resolve(process.cwd(), "src/routes/legalResearch.ts"),
    "utf8",
  );
  const productionAdapterStart = legalResearchRouteSource.indexOf(
    "function productionAdapter",
  );
  const productionAdapterEnd = legalResearchRouteSource.indexOf(
    "\nfunction routeError",
    productionAdapterStart,
  );
  assert.ok(
    productionAdapterStart >= 0 &&
      productionAdapterEnd > productionAdapterStart,
  );
  const productionAdapterSource = legalResearchRouteSource.slice(
    productionAdapterStart,
    productionAdapterEnd,
  );
  for (const gatedConstructor of [
    "createOfficialPublicLegalResearchProviderFromEnvironment",
    "createPkulawLegalResearchProviderFromEnvironment",
    "createYuanDianLegalResearchProviderFromEnvironment",
    "createWoltersLegalResearchProviderFromEnvironment",
  ]) {
    assert.equal(productionAdapterSource.includes(gatedConstructor), true);
  }
  assert.equal(
    productionAdapterSource.includes("createPkulawLegalResearchProvider("),
    false,
  );
  assert.equal(
    productionAdapterSource.includes("createWoltersLegalResearchProvider("),
    false,
  );
  assert.equal(
    productionAdapterSource.includes(
      "createOfficialPublicLegalResearchProvider(",
    ),
    false,
  );

  const providerFactorySource = readFileSync(
    resolve(process.cwd(), "src/lib/aletheia/legalResearchProvider.ts"),
    "utf8",
  );
  const environmentProviderStart = providerFactorySource.indexOf(
    "function environmentProvider",
  );
  const environmentProviderEnd = providerFactorySource.indexOf(
    "\nexport function createPkulawLegalResearchProviderFromEnvironment",
    environmentProviderStart,
  );
  assert.ok(
    environmentProviderStart >= 0 &&
      environmentProviderEnd > environmentProviderStart,
  );
  const environmentProviderSource = providerFactorySource.slice(
    environmentProviderStart,
    environmentProviderEnd,
  );
  assert.equal(
    environmentProviderSource.includes("createPkulawMcpLegalSourceAdapter("),
    true,
  );
  assert.equal(
    environmentProviderSource.includes(
      "createPkulawLegalSourceAdapterFromEnvironment(",
    ),
    true,
  );
  assert.equal(
    environmentProviderSource.includes("requireDeclaredDataUsePolicy: true"),
    true,
  );
  assert.match(
    environmentProviderSource,
    /!ENVIRONMENT_PROVIDER_ACTIVATION_GATE_CLOSED &&\s+dataUsePolicyReady &&\s+deployment\.endpointConfigured/u,
    "an undeclared environment policy must block adapter construction as well as execution",
  );
  assert.match(
    providerFactorySource,
    /input\.activationGateClosed !== true &&\s+dataUsePolicyReady &&\s+input\.credentialRequired/u,
  );

  const localControlSource = readFileSync(
    resolve(process.cwd(), "src/routes/aletheiaLocalControl.ts"),
    "utf8",
  );
  assert.equal(
    localControlSource.includes(
      "legalResearchProviderDescriptorFromEnvironment(provider)",
    ),
    true,
  );
  assert.equal(
    localControlSource.includes(
      "legalResearchProviderDeploymentStatus(provider)",
    ),
    true,
  );
  assert.match(
    localControlSource,
    /LEGAL_SOURCE_RETENTION_ACTIVATION_V13\.open &&\s+dataUsePolicyReady &&\s+item\.configured/u,
  );
  assert.match(
    localControlSource,
    /hasDeclaredDeploymentDataUsePolicy\(\s*descriptor\.dataUsePolicy,?\s*\)/u,
  );

  const readyDeployment = {
    endpointConfigured: true,
    allowlisted: true,
    credentialReferenceConfigured: true,
  };
  assert.deepEqual(
    projectLegalResearchProviderConnectionStatus({
      deployment: readyDeployment,
      credentialRequired: true,
      credentialAvailable: false,
      activationGateClosed: true,
      dataUsePolicyReady: false,
      secretStorageAvailable: false,
    }),
    {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    },
    "the current code-owned gate must retain priority over policy and credential state",
  );
  assert.deepEqual(
    projectLegalResearchProviderConnectionStatus({
      deployment: readyDeployment,
      credentialRequired: true,
      credentialAvailable: false,
      activationGateClosed: false,
      dataUsePolicyReady: false,
      secretStorageAvailable: false,
    }),
    {
      state: "unavailable",
      reason: "data_use_policy_undeclared",
      connectionTested: false,
    },
    "a future open gate must fail before credential access when policy is undeclared",
  );
  assert.deepEqual(
    projectLegalResearchProviderConnectionStatus({
      deployment: {
        ...readyDeployment,
        allowlisted: false,
      },
      credentialRequired: true,
      credentialAvailable: false,
      activationGateClosed: false,
      dataUsePolicyReady: false,
    }),
    {
      state: "unavailable",
      reason: "endpoint_not_allowlisted",
      connectionTested: false,
    },
    "deployment failures must retain priority over the policy gate",
  );

  assert.deepEqual(
    projectLegalResearchProviderConnectionStatus({
      deployment: {
        endpointConfigured: true,
        allowlisted: true,
        credentialReferenceConfigured: true,
      },
      credentialRequired: true,
      credentialAvailable: true,
      secretStorageAvailable: false,
    }),
    {
      state: "unavailable",
      reason: "secret_storage_unavailable",
      connectionTested: false,
    },
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-legal-research-provider-audit-v2",
      checks: [
        "legacy-adapter-compatible-provider-contract",
        "credentialless-official-provider-wrapper",
        "capability-and-data-use-policy-projection",
        "environment-only-declared-data-use-policy-guard",
        "future-open-gate-undeclared-policy-zero-credential-boundary",
        "direct-provider-poc-policy-guard-exemption",
        "configured-unverified-and-unavailable-status",
        "endpoint-credential-redaction",
        "missing-endpoint-does-not-read-credential",
        "official-missing-configuration-boundary",
        "configured-environment-activation-gate-blocks-credential-and-fetch",
        "pkulaw-mcp-and-json-capability-projection",
        "pkulaw-mcp-document-kind-projection",
        "pkulaw-mcp-exact-host-and-invalid-path-fail-closed",
        "pkulaw-mcp-production-constructor-wiring",
        "local-control-uses-environment-aware-provider-projection",
        "production-route-uses-only-gated-environment-providers",
        "secret-storage-unavailable-boundary",
      ],
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
