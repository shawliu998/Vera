import assert from "node:assert/strict";
import {
  createManualLegalSourceImport,
  createOfficialPublicLegalSourceAdapter,
  createPkulawLegalSourceAdapter,
  createWoltersLegalSourceAdapter,
  LegalSourceAdapterError,
} from "../lib/aletheia/legalSourceAdapter";

const endpoint = "https://api.pkulaw.example/v1/legal";
const allowedHosts = ["pkulaw.example"];

function config(overrides: Record<string, unknown> = {}) {
  return {
    endpoint,
    allowedHosts,
    credentialRef: "PKULAW_OFFICIAL_API",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function adapterError(code: LegalSourceAdapterError["code"]) {
  return (error: unknown) => error instanceof LegalSourceAdapterError && error.code === code;
}

async function main() {
  assert.throws(
    () => createPkulawLegalSourceAdapter(config({ endpoint: "http://api.pkulaw.example/v1/legal" })),
    adapterError("policy_violation"),
  );
  assert.throws(
    () => createPkulawLegalSourceAdapter(config({ allowedHosts: ["untrusted.example"] })),
    adapterError("policy_violation"),
  );
  assert.throws(
    () => createPkulawLegalSourceAdapter(config({ credentialRef: "" })),
    adapterError("configuration_error"),
  );

  const requests: Array<{ body: Record<string, string>; redirect?: RequestRedirect }> = [];
  const adapter = createPkulawLegalSourceAdapter(config(), {
    now: () => new Date("2026-07-12T08:00:00.000Z"),
    resolveCredential: async (reference) => {
      assert.equal(reference, "PKULAW_OFFICIAL_API");
      return "audit-only-credential";
    },
    fetch: async (_input, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, string>,
        redirect: init?.redirect,
      });
      if (requests.length === 1) {
        return jsonResponse({
          results: [
            {
              id: "civil-code-509",
              title: "Civil Code Article 509",
              summary: "Performance must follow the agreement.",
              url: "https://www.api.pkulaw.example/documents/civil-code-509",
              version: "2021-01-01",
              effectiveDate: "2021-01-01",
              effectiveTo: "2099-12-31",
              publicationDate: "2020-05-28",
              documentKind: "statute",
            },
          ],
        });
      }
      return jsonResponse({
        document: {
          id: "civil-code-509",
          title: "Civil Code Article 509",
          content: "Parties shall fully perform their obligations as agreed.",
          url: "https://www.api.pkulaw.example/documents/civil-code-509",
          version: "2021-01-01",
          effectiveDate: "2021-01-01",
        },
      });
    },
  });

  const results = await adapter.search({ query: "contract performance" });
  assert.equal(results.length, 1);
  assert.equal(results[0].documentId, "civil-code-509");
  assert.equal(results[0].snapshot.sourceType, "pkulaw");
  assert.equal(results[0].snapshot.url, "https://www.api.pkulaw.example/documents/civil-code-509");
  assert.equal(results[0].snapshot.fetchedAt, "2026-07-12T08:00:00.000Z");
  assert.match(results[0].snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(results[0].snapshot.version, "2021-01-01");
  assert.equal(results[0].snapshot.effectiveDate, "2021-01-01");
  assert.equal(results[0].snapshot.effectiveTo, "2099-12-31");
  assert.equal(results[0].snapshot.documentKind, "statute");

  const document = await adapter.fetch({ documentId: "civil-code-509" });
  assert.equal(document.content, "Parties shall fully perform their obligations as agreed.");
  assert.match(document.snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(requests, [
    { body: { operation: "search", query: "contract performance" }, redirect: "manual" },
    { body: { operation: "fetch", documentId: "civil-code-509" }, redirect: "manual" },
  ]);

  await assert.rejects(
    () => adapter.search({ query: "contract", matter: { id: "m-1" } } as never),
    adapterError("policy_violation"),
  );
  await assert.rejects(
    () => adapter.search({ query: "contract", facts: ["private facts"] } as never),
    adapterError("policy_violation"),
  );
  await assert.rejects(
    () => adapter.fetch({ documentId: "civil-code-509", matterId: "m-1" } as never),
    adapterError("policy_violation"),
  );

  const missingCredential = createWoltersLegalSourceAdapter(
    { ...config(), endpoint: "https://api.wolters.example/v1/legal", allowedHosts: ["wolters.example"] },
    { resolveCredential: async () => undefined },
  );
  await assert.rejects(() => missingCredential.search({ query: "contract" }), adapterError("credential_unavailable"));

  let officialAuthorization: string | null = null;
  const official = createOfficialPublicLegalSourceAdapter(
    { endpoint: "https://api.official.example/v1/legal", allowedHosts: ["official.example"] },
    {
      fetch: async (_input, init) => {
        officialAuthorization = new Headers(init?.headers).get("authorization");
        return jsonResponse({ results: [] });
      },
    },
  );
  assert.deepEqual(await official.search({ query: "civil code" }), []);
  assert.equal(officialAuthorization, null);

  const mismatchedDocumentResponse = () =>
    jsonResponse({
      document: {
        id: "different-document",
        title: "Unexpected document",
        content: "This response was not approved by document ID.",
        url: "https://api.audit.example/documents/different-document",
      },
    });
  const mismatchedAdapters = [
    createPkulawLegalSourceAdapter(
      {
        endpoint: "https://api.audit.example/v1/pkulaw",
        allowedHosts: ["audit.example"],
        credentialRef: "PKULAW_MISMATCH_AUDIT",
      },
      {
        resolveCredential: async () => "audit-only-credential",
        fetch: async () => mismatchedDocumentResponse(),
      },
    ),
    createWoltersLegalSourceAdapter(
      {
        endpoint: "https://api.audit.example/v1/wolters",
        allowedHosts: ["audit.example"],
        credentialRef: "WOLTERS_MISMATCH_AUDIT",
      },
      {
        resolveCredential: async () => "audit-only-credential",
        fetch: async () => mismatchedDocumentResponse(),
      },
    ),
    createOfficialPublicLegalSourceAdapter(
      {
        endpoint: "https://api.audit.example/v1/official",
        allowedHosts: ["audit.example"],
      },
      { fetch: async () => mismatchedDocumentResponse() },
    ),
  ];
  for (const mismatchedAdapter of mismatchedAdapters) {
    await assert.rejects(
      () => mismatchedAdapter.fetch({ documentId: "approved-document" }),
      adapterError("response_invalid"),
      `${mismatchedAdapter.provider} must reject a different provider document ID`,
    );
  }

  const redirectingAdapter = createPkulawLegalSourceAdapter(config(), {
    resolveCredential: async () => "audit-only-credential",
    fetch: async () => jsonResponse({}, { status: 302, headers: { location: "https://api.pkulaw.example/other" } }),
  });
  await assert.rejects(() => redirectingAdapter.search({ query: "contract" }), adapterError("policy_violation"));

  const oversizedAdapter = createPkulawLegalSourceAdapter(config({ maxResponseBytes: 32 }), {
    resolveCredential: async () => "audit-only-credential",
    fetch: async () => jsonResponse({ results: [] }, { headers: { "content-length": "33" } }),
  });
  await assert.rejects(() => oversizedAdapter.search({ query: "contract" }), adapterError("response_invalid"));

  const malformedAdapter = createPkulawLegalSourceAdapter(config(), {
    resolveCredential: async () => "audit-only-credential",
    fetch: async () => jsonResponse({ results: [{ id: "bad", url: "http://api.pkulaw.example/document" }] }),
  });
  await assert.rejects(() => malformedAdapter.search({ query: "contract" }), adapterError("policy_violation"));

  const timeoutAdapter = createPkulawLegalSourceAdapter(config({ timeoutMs: 1 }), {
    resolveCredential: async () => "audit-only-credential",
    fetch: async () => new Promise<Response>(() => undefined),
  });
  await assert.rejects(() => timeoutAdapter.search({ query: "contract" }), adapterError("transport_error"));

  const manual = createManualLegalSourceImport({
    documentId: "counsel-upload-1",
    title: "Counsel-provided statute copy",
    content: "Manual source text.",
    version: "2026 revision",
    effectiveDate: "2026-01-01",
    importedAt: "2026-07-12T08:00:00.000Z",
  });
  assert.equal(manual.snapshot.sourceType, "manual_import");
  assert.equal(manual.snapshot.url, "manual-import://counsel-upload-1");
  assert.match(manual.snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-legal-source-adapter-audit-v1",
      checks: [
        "provider-neutral-search-fetch-contract",
        "official-api-endpoint-host-policy",
        "credential-reference-only",
        "credentialless-official-public-api",
        "query-context-rejection",
        "https-redirect-byte-timeout-policy",
        "response-snapshot-provenance",
        "fetch-response-document-id-binding",
        "manual-import-representation",
      ],
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
