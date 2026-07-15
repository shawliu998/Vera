import assert from "node:assert/strict";
import {
  classifyPkulawMcpEndpoint,
  createPkulawMcpLegalSourceAdapter,
  PKULAW_MCP_TOOL_ALLOWLIST,
  validatePkulawMcpEndpoint,
  type PkulawMcpClientFactoryInput,
  type PkulawMcpClientRequestOptions,
  type PkulawMcpClientSession,
} from "../lib/aletheia/pkulawMcpLegalSourceAdapter";
import { LegalSourceAdapterError } from "../lib/aletheia/legalSourceAdapter";

const APP_ENDPOINT = "https://apim-gw.pkulaw.com/vera_law_semantic_01/mcp";
const DOCUMENTED_ENDPOINT =
  "https://apim-gateway.pkulaw.com/mcp-law-search-service";
const TOKEN = "pkulaw-audit-token-value";
const FIXED_NOW = new Date("2026-07-15T08:30:00.000Z");

function assertAdapterError(
  error: unknown,
  code: LegalSourceAdapterError["code"],
) {
  return error instanceof LegalSourceAdapterError && error.code === code;
}

function fixtureClient(args: {
  result?: unknown;
  onConnect?: (options: PkulawMcpClientRequestOptions) => void;
  onCall?: (
    request: { name: "search_article"; arguments: Record<string, unknown> },
    options: PkulawMcpClientRequestOptions,
  ) => unknown | Promise<unknown>;
  onClose?: () => void;
}): PkulawMcpClientSession {
  return {
    async connect(options) {
      args.onConnect?.(options);
    },
    async callTool(request, options) {
      if (args.onCall) return args.onCall(request, options);
      return args.result;
    },
    async close() {
      args.onClose?.();
    },
  };
}

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "CLI.1.5175219",
    title: "中华人民共和国民法典第一百一十九条",
    summary: "依法成立的合同，对当事人具有法律约束力。",
    content: "依法成立的合同，对当事人具有法律约束力。",
    url: "https://www.pkulaw.com/chl/5175219.html",
    version: "现行有效",
    effectiveDate: "2021-01-01",
    publicationDate: "2020-05-28",
    documentKind: "statute",
    ...overrides,
  };
}

function adapterWithResult(
  result: unknown,
  overrides: {
    maxResponseBytes?: number;
    maxResults?: number;
    onFactory?: (input: PkulawMcpClientFactoryInput) => void;
    onCall?: (
      request: { name: "search_article"; arguments: Record<string, unknown> },
      options: PkulawMcpClientRequestOptions,
    ) => unknown | Promise<unknown>;
    onClose?: () => void;
  } = {},
) {
  return createPkulawMcpLegalSourceAdapter(
    {
      endpoint: APP_ENDPOINT,
      credentialRef: "pkulaw.audit.token",
      ...(overrides.maxResponseBytes
        ? { maxResponseBytes: overrides.maxResponseBytes }
        : {}),
      ...(overrides.maxResults ? { maxResults: overrides.maxResults } : {}),
    },
    {
      resolveCredential: async (reference) => {
        assert.equal(reference, "pkulaw.audit.token");
        return TOKEN;
      },
      now: () => FIXED_NOW,
      createClient: (input) => {
        overrides.onFactory?.(input);
        return fixtureClient({
          result,
          onCall: overrides.onCall,
          onClose: overrides.onClose,
        });
      },
    },
  );
}

async function main() {
  assert.deepEqual(PKULAW_MCP_TOOL_ALLOWLIST, ["search_article"]);

  assert.equal(classifyPkulawMcpEndpoint(APP_ENDPOINT), "approved_mcp");
  assert.equal(classifyPkulawMcpEndpoint(DOCUMENTED_ENDPOINT), "approved_mcp");
  assert.equal(
    classifyPkulawMcpEndpoint(
      "https://apim-gateway.pkulaw.com/mcp-case-search-service",
    ),
    "invalid_mcp_gateway",
  );
  assert.equal(
    classifyPkulawMcpEndpoint("https://enterprise-api.pkulaw.com/v1/legal"),
    "not_mcp",
  );

  assert.equal(
    validatePkulawMcpEndpoint(APP_ENDPOINT).toString(),
    APP_ENDPOINT,
  );
  assert.equal(
    validatePkulawMcpEndpoint(DOCUMENTED_ENDPOINT).toString(),
    DOCUMENTED_ENDPOINT,
  );
  assert.equal(
    validatePkulawMcpEndpoint(`${DOCUMENTED_ENDPOINT}/mcp`).toString(),
    `${DOCUMENTED_ENDPOINT}/mcp`,
  );

  for (const endpoint of [
    "http://apim-gw.pkulaw.com/service/mcp",
    "https://user@apim-gw.pkulaw.com/service/mcp",
    "https://apim-gw.pkulaw.com:444/service/mcp",
    "https://apim-gw.pkulaw.com/service/mcp?token=secret",
    "https://apim-gw.pkulaw.com/service/mcp#fragment",
    "https://apim-gw.pkulaw.com/{SERVICE_ID}/mcp",
    "https://apim-gw.pkulaw.com/service/mcp/",
    "https://apim-gw.pkulaw.com/service//mcp",
    "https://apim-gw.pkulaw.com/service/extra/mcp",
    "https://apim-gw.pkulaw.com.evil.example/service/mcp",
    "https://apim-gateway.pkulaw.com/mcp-case-search-service",
    "https://www.pkulaw.com/mcp-law-search-service",
  ]) {
    assert.throws(
      () => validatePkulawMcpEndpoint(endpoint),
      (error: unknown) =>
        assertAdapterError(error, "policy_violation") ||
        assertAdapterError(error, "configuration_error"),
      endpoint,
    );
  }

  assert.throws(
    () =>
      createPkulawMcpLegalSourceAdapter({
        endpoint: APP_ENDPOINT,
        credentialRef: TOKEN,
        token: TOKEN,
      } as never),
    (error: unknown) => assertAdapterError(error, "configuration_error"),
  );

  let clientCreatedWithoutCredential = false;
  const noCredential = createPkulawMcpLegalSourceAdapter(
    { endpoint: APP_ENDPOINT, credentialRef: "missing.keychain.item" },
    {
      createClient: () => {
        clientCreatedWithoutCredential = true;
        return fixtureClient({});
      },
    },
  );
  await assert.rejects(
    noCredential.search({ query: "劳动合同解除" }),
    (error: unknown) => assertAdapterError(error, "credential_unavailable"),
  );
  assert.equal(clientCreatedWithoutCredential, false);

  for (const badCredential of [
    "",
    `Bearer ${TOKEN}`,
    ` ${TOKEN}`,
    `${TOKEN}\n`,
    `${TOKEN} with-space`,
    `${TOKEN}-密钥`,
  ]) {
    const invalidCredential = createPkulawMcpLegalSourceAdapter(
      { endpoint: APP_ENDPOINT, credentialRef: "invalid.keychain.item" },
      {
        resolveCredential: async () => badCredential,
        createClient: () => fixtureClient({}),
      },
    );
    await assert.rejects(
      invalidCredential.search({ query: "劳动合同解除" }),
      (error: unknown) => assertAdapterError(error, "credential_unavailable"),
    );
  }

  let capturedCall:
    | { name: "search_article"; arguments: Record<string, unknown> }
    | undefined;
  let closeCount = 0;
  const adapter = adapterWithResult(
    { structuredContent: { results: [validItem()] } },
    {
      onFactory(input) {
        assert.equal(input.endpoint.toString(), APP_ENDPOINT);
        assert.equal(input.authorizationHeader, `Bearer ${TOKEN}`);
        assert.equal(input.timeoutMs, 12_000);
        assert.equal(input.maxResponseBytes, 1_000_000);
      },
      onCall(request, options) {
        capturedCall = request;
        assert.equal(options.timeout, 12_000);
        assert.equal(options.maxTotalTimeout, 12_000);
        assert.equal(options.signal.aborted, false);
        return { structuredContent: { results: [validItem()] } };
      },
      onClose() {
        closeCount += 1;
      },
    },
  );
  assert.equal(adapter.provider, "pkulaw");
  const results = await adapter.search({ query: " 依法成立的合同效力 " });
  assert.deepEqual(capturedCall, {
    name: "search_article",
    arguments: { text: "依法成立的合同效力" },
  });
  assert.equal(closeCount, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "中华人民共和国民法典第一百一十九条");
  assert.match(results[0]?.documentId ?? "", /^pkulaw:mcp:[a-f0-9]{64}$/);
  assert.deepEqual(results[0]?.snapshot, {
    url: "https://www.pkulaw.com/chl/5175219.html",
    fetchedAt: FIXED_NOW.toISOString(),
    contentHash:
      "sha256:da4ad71ee5202431acb4566c99d8ce59a5dd8ab11eb4a97547f4ede989a7ff52",
    sourceType: "pkulaw",
    version: "现行有效",
    effectiveDate: "2021-01-01",
    publicationDate: "2020-05-28",
    documentKind: "statute",
  });
  await assert.rejects(
    adapter.fetch({ documentId: results[0]!.documentId }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  const jsonTextAdapter = adapterWithResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          data: { items: [validItem({ id: "CLI.1.2" })] },
        }),
      },
    ],
  });
  assert.equal((await jsonTextAdapter.search({ query: "合同效力" })).length, 1);

  const directArray = adapterWithResult({
    structuredContent: [validItem({ id: "direct-array" })],
  });
  assert.equal((await directArray.search({ query: "合同效力" })).length, 1);

  const explicitBusinessSuccess = adapterWithResult({
    structuredContent: {
      success: true,
      code: 200,
      results: [validItem({ id: "explicit-success" })],
    },
  });
  assert.equal(
    (await explicitBusinessSuccess.search({ query: "合同效力" })).length,
    1,
  );

  for (const malformedBusinessEnvelope of [
    { success: "false", results: [] },
    { code: "500", results: [] },
    { success: true, results: [] },
    { code: 200, results: [] },
    { success: true, code: 0, results: [] },
    { status: "ok", results: [] },
    { payload: { items: [] } },
    { data: { items: [], unknown: true } },
  ]) {
    const malformed = adapterWithResult({
      structuredContent: malformedBusinessEnvelope,
    });
    await assert.rejects(
      malformed.search({ query: "合同效力" }),
      (error: unknown) => assertAdapterError(error, "response_invalid"),
    );
  }

  for (const failedBusinessEnvelope of [
    { success: false, results: [] },
    { code: 500, results: [] },
  ]) {
    const failed = adapterWithResult({
      structuredContent: failedBusinessEnvelope,
    });
    await assert.rejects(
      failed.search({ query: "合同效力" }),
      (error: unknown) => assertAdapterError(error, "transport_error"),
    );
  }

  const unverifiedTextItem = validItem({
    id: "unverified-search-text",
    text: "搜索返回的片段不是经过契约确认的完整原文。",
  });
  delete (unverifiedTextItem as { summary?: unknown }).summary;
  delete (unverifiedTextItem as { content?: unknown }).content;
  const unverifiedText = adapterWithResult({
    structuredContent: { results: [unverifiedTextItem] },
  });
  const unverifiedResults = await unverifiedText.search({ query: "合同效力" });
  assert.equal(
    unverifiedResults[0]?.summary,
    "搜索返回的片段不是经过契约确认的完整原文。",
  );
  await assert.rejects(
    unverifiedText.fetch({ documentId: unverifiedResults[0]!.documentId }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  const summaryOnlyItem = validItem();
  delete (summaryOnlyItem as { content?: unknown }).content;
  const summaryOnly = adapterWithResult({
    structuredContent: {
      results: [summaryOnlyItem],
    },
  });
  const summaryResults = await summaryOnly.search({ query: "合同效力" });
  assert.equal(summaryResults.length, 1);
  await assert.rejects(
    summaryOnly.fetch({ documentId: summaryResults[0]!.documentId }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  await assert.rejects(
    adapter.search({ query: "合同", matterId: "must-not-egress" } as never),
    (error: unknown) => assertAdapterError(error, "policy_violation"),
  );
  await assert.rejects(
    adapter.fetch({ documentId: "pkulaw:mcp:not-valid" }),
    (error: unknown) => assertAdapterError(error, "policy_violation"),
  );

  const foreignSource = adapterWithResult({
    structuredContent: {
      results: [validItem({ url: "https://pkulaw.com.evil.example/document" })],
    },
  });
  await assert.rejects(
    foreignSource.search({ query: "合同效力" }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  const invalidDate = adapterWithResult({
    structuredContent: {
      results: [validItem({ effectiveDate: "2026-02-31" })],
    },
  });
  await assert.rejects(
    invalidDate.search({ query: "合同效力" }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  const tooMany = adapterWithResult(
    {
      structuredContent: {
        results: [validItem(), validItem({ id: "second" })],
      },
    },
    { maxResults: 1 },
  );
  await assert.rejects(
    tooMany.search({ query: "合同效力" }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  const oversized = adapterWithResult(
    {
      structuredContent: {
        results: [validItem({ content: "法".repeat(1_000) })],
      },
    },
    { maxResponseBytes: 512 },
  );
  await assert.rejects(
    oversized.search({ query: "合同效力" }),
    (error: unknown) => assertAdapterError(error, "response_invalid"),
  );

  const toolError = adapterWithResult({
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: "not subscribed" }) },
    ],
  });
  await assert.rejects(
    toolError.search({ query: "合同效力" }),
    (error: unknown) => assertAdapterError(error, "transport_error"),
  );

  let timeoutClosed = false;
  const timeoutAdapter = createPkulawMcpLegalSourceAdapter(
    {
      endpoint: APP_ENDPOINT,
      credentialRef: "pkulaw.timeout.token",
      timeoutMs: 20,
    },
    {
      resolveCredential: async () => TOKEN,
      createClient: () =>
        fixtureClient({
          onCall: (_request, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(new Error("fixture aborted")),
                { once: true },
              );
            }),
          onClose: () => {
            timeoutClosed = true;
          },
        }),
    },
  );
  await assert.rejects(
    timeoutAdapter.search({ query: "合同效力" }),
    (error: unknown) => assertAdapterError(error, "transport_error"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timeoutClosed, true);

  const secretFailure = createPkulawMcpLegalSourceAdapter(
    { endpoint: APP_ENDPOINT, credentialRef: "pkulaw.error.token" },
    {
      resolveCredential: async () => TOKEN,
      createClient: () => {
        throw new Error(`transport leaked ${TOKEN}`);
      },
    },
  );
  await assert.rejects(
    secretFailure.search({ query: "合同效力" }),
    (error: unknown) => {
      assert(assertAdapterError(error, "transport_error"));
      assert.equal((error as Error).message.includes(TOKEN), false);
      return true;
    },
  );

  let redirectInit: RequestInit | undefined;
  const redirectAdapter = createPkulawMcpLegalSourceAdapter(
    {
      endpoint: DOCUMENTED_ENDPOINT,
      credentialRef: "pkulaw.redirect.token",
      timeoutMs: 500,
    },
    {
      resolveCredential: async () => TOKEN,
      fetch: async (_input, init) => {
        redirectInit = init;
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        });
      },
    },
  );
  await assert.rejects(
    redirectAdapter.search({ query: "合同效力" }),
    (error: unknown) =>
      assertAdapterError(error, "policy_violation") ||
      assertAdapterError(error, "transport_error"),
  );
  assert(redirectInit);
  assert.equal(redirectInit.redirect, "manual");
  assert.equal(
    new Headers(redirectInit.headers).get("authorization"),
    `Bearer ${TOKEN}`,
  );
  assert.equal(redirectInit.method, "POST");

  console.log(
    JSON.stringify(
      {
        ok: true,
        adapter: "pkulaw-mcp-law-semantic",
        sdkTransport: "StreamableHTTPClientTransport",
        endpointPolicy: "official-host-and-bounded-service-path",
        toolAllowlist: PKULAW_MCP_TOOL_ALLOWLIST,
        dynamicToolExposure: false,
        businessEnvelopePolicy: "explicit-typed-success-structures-only",
        fetchPolicy: "always-fail-closed-until-precise-article-service",
        crossRequestFullTextCache: false,
        realCredentialUsed: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
