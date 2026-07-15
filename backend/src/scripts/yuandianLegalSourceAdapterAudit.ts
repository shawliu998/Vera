import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  LegalSourceAdapterError,
  type LegalSourceAdapter,
} from "../lib/aletheia/legalSourceAdapter";
import {
  createYuanDianLegalSourceAdapter,
  YUANDIAN_MCP_METADATA,
  YUANDIAN_REST_ENDPOINTS,
} from "../lib/aletheia/yuandianLegalSourceAdapter";

const FIXED_NOW = "2026-07-15T08:00:00.000Z";
const API_KEY = "fixture-only-yuandian-key";
const ARTICLE_ID = "aecabfbe6b0843642509a7f1ff865413_264";
const REGULATION_ID = "aecabfbe6b0843642509a7f1ff865413";
const ORDINARY_CASE_ID = "b5c63a4ec01df9495b6b9024bf0a2bee";
const AUTHORITY_CASE_ID = "0908d3828fe6410ba341e1a66eab8d85";

// Shapes are reduced fixtures from the corresponding official API documents.
const LAW_SEARCH_FIXTURE = {
  msg: "成功(返回结构化数据)",
  code: 201,
  answer: "",
  extra: {
    fatiao: [
      {
        ftid: ARTICLE_ID,
        fgid: REGULATION_ID,
        fgtitle: "中华人民共和国刑法(2023修正)",
        num: "第二百六十四条",
        content: "【盗窃罪】盗窃公私财物，数额较大的，依法承担相应刑事责任。",
        sxx: "现行有效",
        effect1: "法律",
        effect2: "法律",
        location: "中央",
        start: 20240301,
        end: 99999999,
        dy: "中央",
        score: 1.107480312,
        type: 1,
      },
    ],
  },
  request_id: "fixture-law-request",
};

const CASE_SEARCH_FIXTURE = {
  msg: "成功(返回结构化数据)",
  code: 201,
  answer: "",
  extra: {
    wenshu: [
      {
        type: 2,
        scid: ORDINARY_CASE_ID,
        spcx: "二审案件",
        ajlb: "刑事案件",
        jbdw: "北京市第一中级人民法院",
        title: "吕某盗窃二审刑事判决书",
        jand: 2019,
        jaDate: 20191223,
        wszl: "判决书",
        ah: "（2019）京01刑终629号",
        content: "本案围绕入户盗窃的定罪与量刑展开。",
        xzqh_p: "北京",
        cj: "中级",
        score: 1.0098828125,
        authority: "",
        db: "精选案例库",
      },
    ],
  },
  request_id: "fixture-case-request",
};

const ARTICLE_DETAIL_FIXTURE = {
  code: 200,
  data: {
    ft_num: "第二百六十四条",
    ssrq: "2024-03-01",
    type: "法条",
    title: "中华人民共和国刑法(2023修正)第二百六十四条",
    tid: "264",
    url: `/zxt/statuteDetail/detailPage/${REGULATION_ID}?text=264`,
    content:
      "【盗窃罪】盗窃公私财物，数额较大的，或者多次盗窃、入户盗窃的，依法处罚。",
    sxx: "现行有效",
    fgid: REGULATION_ID,
    ftmc: "中华人民共和国刑法(2023修正)第二百六十四条",
    fbrq: "2023-12-29",
    xljb_2: "法律",
    xljb_1: "法律",
    fgmc: "中华人民共和国刑法(2023修正)",
    id: ARTICLE_ID,
  },
  message: "请求成功",
  status: "success",
};

const REGULATION_DETAIL_FIXTURE = {
  code: 200,
  data: {
    type: "法规",
    id: REGULATION_ID,
    fgid: REGULATION_ID,
    url: `/zxt/statuteDetail/detailPage/${REGULATION_ID}`,
    title: "中华人民共和国刑法(2023修正)",
    fgmc: "中华人民共和国刑法(2023修正)",
    content: "中华人民共和国刑法（节选 fixture）。",
    sxx: "现行有效",
    xljb_1: "法律",
    xljb_2: "法律",
    fbrq: "2023-12-29",
    ssrq: "2024-03-01",
  },
  status: "success",
  message: "请求成功",
};

const ORDINARY_CASE_DETAIL_FIXTURE = {
  code: 200,
  data: [
    {
      type: "普通案例",
      id: ORDINARY_CASE_ID,
      ah: "（2019）京01刑终629号",
      title: "吕某盗窃二审刑事判决书",
      jbdw: "北京市第一中级人民法院",
      ajlb: "刑事案件",
      spcx: "二审案件",
      wszl: "判决书",
      cprq: "2019年12月23日",
      content: "北京市第一中级人民法院就本案作出二审刑事判决。",
      url: `https://ydzk.chineselaw.com/ydzk/caseDetail/case/${ORDINARY_CASE_ID}`,
    },
  ],
  message: "请求成功",
  status: "success",
};

const AUTHORITY_CASE_DETAIL_FIXTURE = {
  code: 200,
  data: [
    {
      type: "权威案例",
      id: AUTHORITY_CASE_ID,
      ah: "（2021）最高法民申5588号",
      title:
        "指导性案例230号：新某航运有限公司诉中国机某国际合作股份有限公司海上货物运输合同纠纷案",
      jbdw: "最高人民法院",
      ajlb: "民事案件",
      spcx: "再审案件",
      cprq: "2021年12月09日",
      content: "契约托运人与实际托运人的责任应当依法区分。",
      url: `https://ydzk.chineselaw.com/ydzk/caseDetail/qwcase/${AUTHORITY_CASE_ID}`,
    },
  ],
  message: "请求成功",
  status: "success",
};

type RecordedRequest = {
  url: string;
  method: string;
  redirect?: RequestRedirect;
  apiKey: string | null;
  authorization: string | null;
  contentType: string | null;
  body?: unknown;
};

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function jsonResponse(
  value: unknown,
  options: ResponseInit & { responseUrl?: string } = {},
) {
  const { responseUrl, ...init } = options;
  const response = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
  if (responseUrl !== undefined) {
    Object.defineProperty(response, "url", { value: responseUrl });
  }
  return response;
}

function errorCode(code: LegalSourceAdapterError["code"]) {
  return (error: unknown) =>
    error instanceof LegalSourceAdapterError && error.code === code;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    credentialRef: "keychain:vera:yuandian-api-key",
    resultsPerKind: 1,
    ...overrides,
  };
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input.url;
}

function createFixtureFetch(
  requests: RecordedRequest[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    const headers = new Headers(init?.headers);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as unknown)
      : undefined;
    requests.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      apiKey: headers.get("x-api-key"),
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      ...(body === undefined ? {} : { body }),
    });

    if (url.pathname === "/open/law_vector_search") {
      return jsonResponse(LAW_SEARCH_FIXTURE, { responseUrl: url.toString() });
    }
    if (url.pathname === "/open/case_vector_search") {
      return jsonResponse(CASE_SEARCH_FIXTURE, { responseUrl: url.toString() });
    }
    if (url.pathname === "/open/rh_ft_detail") {
      return jsonResponse(ARTICLE_DETAIL_FIXTURE, {
        responseUrl: url.toString(),
      });
    }
    if (url.pathname === "/open/rh_fg_detail") {
      return jsonResponse(REGULATION_DETAIL_FIXTURE, {
        responseUrl: url.toString(),
      });
    }
    if (url.pathname === "/open/rh_case_details") {
      return jsonResponse(
        url.searchParams.get("id") === AUTHORITY_CASE_ID
          ? AUTHORITY_CASE_DETAIL_FIXTURE
          : ORDINARY_CASE_DETAIL_FIXTURE,
        { responseUrl: url.toString() },
      );
    }
    throw new Error(`Unexpected fixture URL: ${url.toString()}`);
  };
}

async function auditHappyPath() {
  const requests: RecordedRequest[] = [];
  let credentialResolutions = 0;
  const adapter = createYuanDianLegalSourceAdapter(baseConfig(), {
    now: () => new Date(FIXED_NOW),
    resolveCredential: async (reference) => {
      credentialResolutions += 1;
      assert.equal(reference, "keychain:vera:yuandian-api-key");
      return API_KEY;
    },
    fetch: createFixtureFetch(requests),
  });
  const providerContract: LegalSourceAdapter = adapter;
  assert.equal(providerContract.provider, "yuandian");

  const results = await adapter.search({ query: "入户盗窃如何定罪" });
  assert.equal(results.length, 2);
  const law = results[0];
  assert.equal(law.documentId, `yuandian:article:${ARTICLE_ID}`);
  assert.equal(law.snapshot.sourceType, "yuandian");
  assert.equal(law.snapshot.provider, "yuandian");
  assert.equal(law.snapshot.recordType, "law_article");
  assert.equal(law.snapshot.regulationId, REGULATION_ID);
  assert.equal(law.snapshot.articleNumber, "第二百六十四条");
  assert.equal(law.snapshot.validityStatus, "现行有效");
  assert.equal(law.snapshot.authorityLevel, "法律");
  assert.equal(law.snapshot.effectiveDate, "2024-03-01");
  assert.equal(law.snapshot.effectiveTo, undefined);
  assert.equal(law.snapshot.documentKind, "statute");
  assert.equal(law.snapshot.fetchedAt, FIXED_NOW);
  assert.equal(
    law.snapshot.contentHash,
    hash(LAW_SEARCH_FIXTURE.extra.fatiao[0].content),
  );
  assert.match(law.snapshot.url, /^https:\/\/www\.chineselaw\.com\//);
  assert.equal(
    law.snapshot.transportUrl,
    YUANDIAN_REST_ENDPOINTS.articleDetail,
  );

  const legalCase = results[1];
  assert.equal(legalCase.documentId, `yuandian:case:auto:${ORDINARY_CASE_ID}`);
  assert.equal(legalCase.snapshot.documentKind, "case");
  assert.equal(legalCase.snapshot.caseNumber, "（2019）京01刑终629号");
  assert.equal(legalCase.snapshot.caseNumberFormatValid, true);
  assert.equal(legalCase.snapshot.caseVerificationStatus, "unverified");
  assert.equal(legalCase.snapshot.judgmentDate, "2019-12-23");
  assert.equal(legalCase.snapshot.publicationDate, "2019-12-23");
  assert.equal(legalCase.snapshot.court, "北京市第一中级人民法院");

  const article = await adapter.fetch({
    documentId: `yuandian:article:${ARTICLE_ID}`,
  });
  assert.equal(article.content, ARTICLE_DETAIL_FIXTURE.data.content);
  assert.equal(article.snapshot.publicationDate, "2023-12-29");
  assert.equal(article.snapshot.effectiveDate, "2024-03-01");
  assert.equal(article.snapshot.contentHash, hash(article.content));
  assert.equal(
    article.snapshot.providerSourceUrl,
    `https://www.chineselaw.com/zxt/statuteDetail/detailPage/${REGULATION_ID}?text=264`,
  );

  const regulation = await adapter.fetch({
    documentId: `yuandian:regulation:${REGULATION_ID}`,
  });
  assert.equal(regulation.snapshot.recordType, "law_regulation");
  assert.equal(regulation.snapshot.validityStatus, "现行有效");
  assert.equal(regulation.snapshot.contentHash, hash(regulation.content));

  const ordinaryCase = await adapter.fetch({
    documentId: `yuandian:case:auto:${ORDINARY_CASE_ID}`,
  });
  assert.equal(ordinaryCase.snapshot.caseVerificationStatus, "verified");
  assert.equal(ordinaryCase.snapshot.judgmentDate, "2019-12-23");
  assert.equal(
    ordinaryCase.snapshot.url,
    `https://ydzk.chineselaw.com/ydzk/caseDetail/case/${ORDINARY_CASE_ID}`,
  );

  const authorityCase = await adapter.fetch({
    documentId: `yuandian:case:qwal:${AUTHORITY_CASE_ID}`,
  });
  assert.equal(authorityCase.snapshot.caseNumber, "（2021）最高法民申5588号");
  assert.equal(authorityCase.snapshot.caseVerificationStatus, "verified");
  assert.equal(authorityCase.snapshot.court, "最高人民法院");

  assert.equal(credentialResolutions, 5);
  assert.equal(requests.length, 6);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "open.chineselaw.com");
    assert.equal(url.port, "");
    assert.equal(request.redirect, "manual");
    assert.equal(request.apiKey, API_KEY);
    assert.equal(request.authorization, null);
  }

  const lawSearch = requests.find((request) =>
    request.url.includes("/open/law_vector_search"),
  );
  assert.deepEqual(lawSearch?.body, {
    query: "入户盗窃如何定罪",
    rewrite_flag: false,
    return_num: 1,
  });
  const caseSearch = requests.find((request) =>
    request.url.includes("/open/case_vector_search"),
  );
  assert.deepEqual(caseSearch?.body, {
    query: "入户盗窃如何定罪",
    rewrite_flag: false,
    wenshu_filter: { dianxing: false },
    return_num: 1,
  });
  const caseFetch = requests.find((request) =>
    request.url.includes(`id=${ORDINARY_CASE_ID}`),
  );
  assert.equal(caseFetch?.method, "GET");
  assert.equal(caseFetch?.body, undefined);
  const authorityFetch = requests.find((request) =>
    request.url.includes(`id=${AUTHORITY_CASE_ID}`),
  );
  assert.equal(
    new URL(authorityFetch?.url ?? "https://invalid.test").searchParams.get(
      "type",
    ),
    "qwal",
  );
}

async function auditConfigurationAndRequestPolicy() {
  assert.throws(
    () => createYuanDianLegalSourceAdapter(baseConfig({ credentialRef: "" })),
    errorCode("configuration_error"),
  );
  assert.throws(
    () =>
      createYuanDianLegalSourceAdapter(
        baseConfig({ credentialRef: "keychain:vera/yuandian-api-key" }),
      ),
    errorCode("configuration_error"),
  );
  assert.throws(
    () =>
      createYuanDianLegalSourceAdapter(
        baseConfig({ endpoint: "https://evil.test" }),
      ),
    errorCode("configuration_error"),
  );
  assert.throws(
    () => createYuanDianLegalSourceAdapter(baseConfig({ timeoutMs: 60_001 })),
    errorCode("configuration_error"),
  );
  assert.throws(
    () =>
      createYuanDianLegalSourceAdapter(
        baseConfig({ maxResponseBytes: 5_000_001 }),
      ),
    errorCode("configuration_error"),
  );
  assert.throws(
    () => createYuanDianLegalSourceAdapter(baseConfig({ resultsPerKind: 46 })),
    errorCode("configuration_error"),
  );

  let fetchCalls = 0;
  const missingCredential = createYuanDianLegalSourceAdapter(baseConfig(), {
    resolveCredential: async () => undefined,
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    () => missingCredential.search({ query: "民法典" }),
    errorCode("credential_unavailable"),
  );
  assert.equal(fetchCalls, 0);

  const adapter = createYuanDianLegalSourceAdapter(baseConfig(), {
    resolveCredential: async () => API_KEY,
    fetch: createFixtureFetch([]),
  });
  await assert.rejects(
    () => adapter.search({ query: "民法典", facts: ["private"] } as never),
    errorCode("policy_violation"),
  );
  await assert.rejects(
    () => adapter.search({ query: " ".repeat(2) }),
    errorCode("policy_violation"),
  );
  await assert.rejects(
    () =>
      adapter.fetch({
        documentId: "https://open.chineselaw.com/open/rh_case_details?id=x",
      }),
    errorCode("policy_violation"),
  );
  await assert.rejects(
    () =>
      adapter.fetch({
        documentId: `yuandian:case:auto:${ORDINARY_CASE_ID}`,
        matterId: "matter-1",
      } as never),
    errorCode("policy_violation"),
  );
}

async function auditTransportAndSchemaPolicy() {
  const dependencies = (fetch: typeof globalThis.fetch) => ({
    resolveCredential: async () => API_KEY,
    fetch,
  });

  const redirect = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async () =>
      jsonResponse(
        {},
        {
          status: 302,
          headers: { location: "https://evil.test" },
        },
      ),
    ),
  );
  await assert.rejects(
    () => redirect.search({ query: "民法典" }),
    errorCode("policy_violation"),
  );

  const offHost = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async () =>
      jsonResponse(LAW_SEARCH_FIXTURE, {
        responseUrl: "https://sub.open.chineselaw.com/open/law_vector_search",
      }),
    ),
  );
  await assert.rejects(
    () => offHost.search({ query: "民法典" }),
    errorCode("policy_violation"),
  );

  const wrongContentType = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(
      async () =>
        new Response("{}", { headers: { "content-type": "text/html" } }),
    ),
  );
  await assert.rejects(
    () => wrongContentType.search({ query: "民法典" }),
    errorCode("response_invalid"),
  );

  const oversized = createYuanDianLegalSourceAdapter(
    baseConfig({ maxResponseBytes: 64 }),
    dependencies(async () =>
      jsonResponse({}, { headers: { "content-length": "65" } }),
    ),
  );
  await assert.rejects(
    () => oversized.search({ query: "民法典" }),
    errorCode("response_invalid"),
  );

  const unauthorized = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async () =>
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    ),
  );
  await assert.rejects(
    () => unauthorized.search({ query: "民法典" }),
    errorCode("credential_unavailable"),
  );

  const businessUnauthorized = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async () => jsonResponse({ code: 401, msg: "鉴权失败" })),
  );
  await assert.rejects(
    () => businessUnauthorized.search({ query: "民法典" }),
    errorCode("credential_unavailable"),
  );

  const malformedLaw = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async (input) => {
      const url = new URL(requestUrl(input));
      return jsonResponse(
        url.pathname.includes("law_vector")
          ? { code: 201, extra: { fatiao: [{ ftid: "../escape" }] } }
          : CASE_SEARCH_FIXTURE,
        { responseUrl: url.toString() },
      );
    }),
  );
  await assert.rejects(
    () => malformedLaw.search({ query: "民法典" }),
    errorCode("response_invalid"),
  );

  const tooMany = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async (input) => {
      const url = new URL(requestUrl(input));
      return jsonResponse(
        url.pathname.includes("law_vector")
          ? {
              ...LAW_SEARCH_FIXTURE,
              extra: {
                fatiao: [
                  LAW_SEARCH_FIXTURE.extra.fatiao[0],
                  LAW_SEARCH_FIXTURE.extra.fatiao[0],
                ],
              },
            }
          : CASE_SEARCH_FIXTURE,
        { responseUrl: url.toString() },
      );
    }),
  );
  await assert.rejects(
    () => tooMany.search({ query: "民法典" }),
    errorCode("response_invalid"),
  );

  const badSource = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async (input) => {
      const url = new URL(requestUrl(input));
      return jsonResponse(
        {
          ...ARTICLE_DETAIL_FIXTURE,
          data: {
            ...ARTICLE_DETAIL_FIXTURE.data,
            url: "https://evil.test/source",
          },
        },
        { responseUrl: url.toString() },
      );
    }),
  );
  await assert.rejects(
    () => badSource.fetch({ documentId: `yuandian:article:${ARTICLE_ID}` }),
    errorCode("response_invalid"),
  );

  const mismatchedCase = createYuanDianLegalSourceAdapter(
    baseConfig(),
    dependencies(async (input) => {
      const url = new URL(requestUrl(input));
      return jsonResponse(AUTHORITY_CASE_DETAIL_FIXTURE, {
        responseUrl: url.toString(),
      });
    }),
  );
  await assert.rejects(
    () =>
      mismatchedCase.fetch({
        documentId: `yuandian:case:auto:${ORDINARY_CASE_ID}`,
      }),
    errorCode("response_invalid"),
  );

  const timedOut = createYuanDianLegalSourceAdapter(
    baseConfig({ timeoutMs: 1 }),
    dependencies(async () => new Promise<Response>(() => undefined)),
  );
  await assert.rejects(
    () => timedOut.search({ query: "民法典" }),
    errorCode("transport_error"),
  );
}

async function main() {
  await auditHappyPath();
  await auditConfigurationAndRequestPolicy();
  await auditTransportAndSchemaPolicy();

  assert.equal(
    YUANDIAN_MCP_METADATA.servers.law,
    "https://open.chineselaw.com/mcp/law/stream",
  );
  assert.equal(YUANDIAN_MCP_METADATA.samplingEnabled, false);
  for (const endpoint of Object.values(YUANDIAN_REST_ENDPOINTS)) {
    const url = new URL(endpoint);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "open.chineselaw.com");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-yuandian-legal-source-adapter-audit-v1",
      checks: [
        "official-law-and-case-fixture-normalization",
        "typed-article-regulation-case-fetch",
        "validity-date-case-number-source-hash-provenance",
        "credential-reference-and-x-api-key-only",
        "exact-open-chineselaw-host-and-manual-redirects",
        "timeout-and-response-byte-limits",
        "http-business-code-and-json-schema-validation",
        "private-context-and-untyped-document-id-rejection",
        "mcp-metadata-is-non-executing",
        "no-live-credential-calls",
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
