import { createHash } from "node:crypto";

import { z } from "zod";

import {
  READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
  READ_ONLY_SOURCE_COVERAGE_VERSION,
  READ_ONLY_SOURCE_DISCOVERY_VERSION,
  READ_ONLY_SOURCE_SNAPSHOT_VERSION,
  readOnlySourceConnectorPinSchema,
  type ReadOnlySourceConnectorPinV1,
  type ReadOnlySourceOperationV1,
  type ReadOnlySourceRequestV1,
} from "../../agent-kernel/connectors/readOnlySourceContract";
import {
  ReadOnlySourceInvocationError,
  type ReadOnlySourceBoundInvokerV1,
  type ReadOnlySourceNormalizerV1,
} from "../../agent-kernel/connectors/readOnlySourceExecution";
import {
  EPO_OPS_DEFAULT_PRIMITIVES,
  EPO_OPS_HOST,
  EpoOpsHttpError,
  type EpoOpsCredentialsV1,
  type EpoOpsSourcePrimitivesV1,
} from "./epoOpsHttp";
import {
  EPO_OPS_MAXIMUM_RAW_XML_CHARS,
  EPO_OPS_MAXIMUM_SOURCE_BODY_CHARS,
  EPO_OPS_PUBLICATION_NUMBER,
  EPO_OPS_SOURCE_HOST,
  normalizeEpoOpsPublicationNumber,
  parseEpoOpsFullText,
  parseEpoOpsSearchResponse,
  parseEpoOpsSinglePublication,
  type EpoOpsPublicationSummary,
} from "./epoOpsXml";

export type { EpoOpsCredentialsV1, EpoOpsSourcePrimitivesV1 } from "./epoOpsHttp";

const PROVIDER_ID = "epo-ops";
const CONNECTOR_ID = "patent.epo-ops.publications";
const MAXIMUM_QUERY_CHARS = 1_800;
const MAXIMUM_PAGE_SIZE = 100;
const JURISDICTIONS = [
  "AU",
  "BR",
  "CA",
  "CN",
  "DE",
  "EP",
  "ES",
  "FR",
  "GB",
  "IN",
  "IT",
  "JP",
  "KR",
  "MX",
  "NL",
  "RU",
  "SG",
  "TW",
  "US",
  "WO",
] as const;

function digest(contract: string) {
  return `sha256:${createHash("sha256").update(contract).digest("hex")}`;
}

export const EPO_OPS_SOURCE_CONNECTOR_PIN =
  readOnlySourceConnectorPinSchema.parse({
    schema_version: READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
    connector_id: CONNECTOR_ID,
    connector_version: "1.0.0",
    provider_id: PROVIDER_ID,
    provider_version: "3.2",
    adapter_id: "vera.patent.epo-ops",
    adapter_version: "1.0.0",
    binding: {
      kind: "http",
      operation_id: "epo-ops.publications.readonly",
      operation_version: "1.0.0",
      input_schema_version: "epo_ops_publication_request_v1",
      input_schema_digest: digest(
        "operation|query|jurisdiction|as_of_date|page|page_size|external_id",
      ),
      output_schema_version: "epo_ops_publication_response_v1",
      output_schema_digest: digest(
        "search(cql,range,biblio_xml)|read(publication_number,biblio_xml,description_xml,claims_xml)",
      ),
    },
    allowed_hosts: [EPO_OPS_HOST],
    allowed_source_hosts: [EPO_OPS_SOURCE_HOST],
    allowed_jurisdictions: [...JURISDICTIONS],
    allowed_operations: ["search", "read_snapshot"],
    allowed_egress_fields: [
      "query",
      "jurisdiction",
      "as_of_date",
      "page",
      "page_size",
      "external_id",
    ],
    limits: {
      timeout_ms: 15_000,
      authorization_max_age_ms: 60_000,
      maximum_pages: 10,
      maximum_items_per_page: MAXIMUM_PAGE_SIZE,
      maximum_query_chars: MAXIMUM_QUERY_CHARS,
      maximum_snapshot_chars: EPO_OPS_MAXIMUM_SOURCE_BODY_CHARS,
    },
    fixed: true,
    read_only: true,
  });

const searchRawSchema = z
  .object({
    operation: z.literal("search"),
    cql: z.string().min(1).max(2_000),
    range: z.string().regex(/^\d+-\d+$/),
    biblio_xml: z.string().min(1).max(EPO_OPS_MAXIMUM_RAW_XML_CHARS),
  })
  .strict();

const readRawSchema = z
  .object({
    operation: z.literal("read_snapshot"),
    publication_number: z.string().regex(EPO_OPS_PUBLICATION_NUMBER),
    biblio_xml: z.string().min(1).max(EPO_OPS_MAXIMUM_RAW_XML_CHARS),
    description_xml: z
      .string()
      .min(1)
      .max(EPO_OPS_MAXIMUM_RAW_XML_CHARS)
      .nullable(),
    claims_xml: z
      .string()
      .min(1)
      .max(EPO_OPS_MAXIMUM_RAW_XML_CHARS)
      .nullable(),
  })
  .strict();

function normalizeCredential(value: string) {
  const normalized = value.trim();
  return normalized && normalized.length <= 512 ? normalized : null;
}

function selectedPublication(request: Readonly<ReadOnlySourceRequestV1>) {
  if (request.operation !== "read_snapshot" || !request.external_id) return null;
  const match = /^publication:([A-Z]{2}[A-Z0-9./-]{1,38})$/i.exec(
    request.external_id,
  );
  if (!match || !request.jurisdiction) return null;
  const publicationNumber = normalizeEpoOpsPublicationNumber(match[1]!);
  return EPO_OPS_PUBLICATION_NUMBER.test(publicationNumber) &&
    publicationNumber.startsWith(request.jurisdiction)
    ? publicationNumber
    : null;
}

function acceptsRequest(request: Readonly<ReadOnlySourceRequestV1>) {
  if (request.operation === "search") {
    return Boolean(
      request.query &&
        request.as_of_date &&
        request.jurisdiction &&
        request.query.length <= MAXIMUM_QUERY_CHARS &&
        !/[\u0000-\u001f\u007f]/.test(request.query),
    );
  }
  return Boolean(selectedPublication(request) && request.as_of_date);
}

function compileSearchCql(payload: Readonly<Record<string, string | number>>) {
  const query = String(payload.query);
  const jurisdiction = String(payload.jurisdiction).toUpperCase();
  const asOfDate = String(payload.as_of_date).replaceAll("-", "");
  return `(${query}) and pn=${jurisdiction} and pd<=${asOfDate}`;
}

function expectedRange(request: ReadOnlySourceRequestV1) {
  const begin = (request.page! - 1) * request.page_size! + 1;
  return `${begin}-${begin + request.page_size! - 1}`;
}

function classifyInvocation(error: unknown) {
  if (error instanceof EpoOpsHttpError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      (error.operation === "token" && error.status === 400)
    ) {
      return "provider_configuration" as const;
    }
    if (error.status === 429 || error.status >= 500) {
      return "provider_capacity" as const;
    }
    return "provider_protocol" as const;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/rate limit|\b429\b|\b5\d\d\b|unavailable/i.test(message)) {
    return "provider_capacity" as const;
  }
  if (/credential|token|secret|unauthori[sz]ed|forbidden/i.test(message)) {
    return "provider_configuration" as const;
  }
  return "provider_network" as const;
}

export function createEpoOpsSourceInvoker(input: {
  operation: Extract<ReadOnlySourceOperationV1, "search" | "read_snapshot">;
  credentials: EpoOpsCredentialsV1;
  primitives?: EpoOpsSourcePrimitivesV1;
  nowMs?: () => number;
}): ReadOnlySourceBoundInvokerV1 {
  const primitives = input.primitives ?? EPO_OPS_DEFAULT_PRIMITIVES;
  const nowMs = input.nowMs ?? Date.now;
  const credentials = {
    consumerKey: normalizeCredential(input.credentials.consumerKey),
    consumerSecret: normalizeCredential(input.credentials.consumerSecret),
  };
  let token: { value: string; expiresAtMs: number } | null = null;
  const accessToken = async (signal: AbortSignal) => {
    if (!credentials.consumerKey || !credentials.consumerSecret) {
      throw new ReadOnlySourceInvocationError("provider_configuration");
    }
    if (token && token.expiresAtMs > nowMs() + 30_000) return token.value;
    const fetched = await primitives.getAccessToken({
      credentials: {
        consumerKey: credentials.consumerKey,
        consumerSecret: credentials.consumerSecret,
      },
      signal,
    });
    if (
      !fetched.accessToken ||
      fetched.accessToken.length > 4_096 ||
      !Number.isFinite(fetched.expiresInSeconds)
    ) {
      throw new ReadOnlySourceInvocationError("provider_protocol");
    }
    token = {
      value: fetched.accessToken,
      expiresAtMs:
        nowMs() + Math.max(0, fetched.expiresInSeconds - 30) * 1_000,
    };
    return token.value;
  };

  return {
    connectorId: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    host: EPO_OPS_HOST,
    binding: EPO_OPS_SOURCE_CONNECTOR_PIN.binding,
    acceptsRequest: (request) =>
      request.operation === input.operation && acceptsRequest(request),
    async invoke(payload, options) {
      try {
        const access = await accessToken(options.signal);
        if (input.operation === "search") {
          const begin = (Number(payload.page) - 1) * Number(payload.page_size) + 1;
          const range = `${begin}-${begin + Number(payload.page_size) - 1}`;
          const cql = compileSearchCql(payload);
          return {
            operation: "search",
            cql,
            range,
            biblio_xml: await primitives.searchBiblio({
              accessToken: access,
              query: cql,
              range,
              signal: options.signal,
            }),
          };
        }
        const publicationNumber = normalizeEpoOpsPublicationNumber(
          String(payload.external_id).replace(/^publication:/i, ""),
        );
        const [biblioXml, fullText] = await Promise.all([
          primitives.readBiblio({
            accessToken: access,
            publicationNumber,
            signal: options.signal,
          }),
          primitives.readFullText({
            accessToken: access,
            publicationNumber,
            signal: options.signal,
          }),
        ]);
        return {
          operation: "read_snapshot",
          publication_number: publicationNumber,
          biblio_xml: biblioXml,
          description_xml: fullText.descriptionXml,
          claims_xml: fullText.claimsXml,
        };
      } catch (error) {
        if (error instanceof ReadOnlySourceInvocationError) throw error;
        throw new ReadOnlySourceInvocationError(classifyInvocation(error));
      }
    },
  };
}

function withinRequestedScope(
  publication: EpoOpsPublicationSummary,
  request: ReadOnlySourceRequestV1,
) {
  return (
    publication.jurisdiction === request.jurisdiction &&
    Boolean(publication.publicationDate) &&
    Boolean(request.as_of_date) &&
    publication.publicationDate! <= request.as_of_date!
  );
}

function metadata(
  publication: EpoOpsPublicationSummary,
  extras: Record<string, string | number | boolean | string[] | null> = {},
) {
  return Object.fromEntries(
    Object.entries({
      publication_number: publication.publicationNumber,
      jurisdiction: publication.jurisdiction,
      kind_code: publication.kindCode,
      abstract: publication.abstract?.slice(0, 4_000) ?? null,
      publication_date: publication.publicationDate,
      filing_date: publication.filingDate,
      priority_dates: publication.priorityDates,
      applicants: publication.applicants,
      inventors: publication.inventors,
      classifications: publication.classifications,
      family_id: publication.familyId,
      ...extras,
    }).filter(([, value]) => value !== null && value !== ""),
  );
}

export function createEpoOpsSourceNormalizer(input: {
  now?: () => string;
  pin?: ReadOnlySourceConnectorPinV1;
} = {}): ReadOnlySourceNormalizerV1 {
  const pin = input.pin ?? EPO_OPS_SOURCE_CONNECTOR_PIN;
  const now = input.now ?? (() => new Date().toISOString());
  return {
    pin,
    async normalize({ raw, request }) {
      if (request.operation === "search") {
        const response = searchRawSchema.parse(raw);
        if (
          response.cql !==
            compileSearchCql({
              query: request.query!,
              jurisdiction: request.jurisdiction!,
              as_of_date: request.as_of_date!,
            }) ||
          response.range !== expectedRange(request)
        ) {
          throw new Error("epo_ops_request_binding_drift");
        }
        const parsed = parseEpoOpsSearchResponse(response.biblio_xml);
        const pageOffset = (request.page! - 1) * request.page_size!;
        if (
          parsed.results.length > request.page_size! ||
          parsed.totalResults < pageOffset + parsed.results.length ||
          parsed.results.some((result) => !withinRequestedScope(result, request))
        ) {
          throw new Error("epo_ops_result_scope_drift");
        }
        const discoveries = parsed.results.map((publication) => ({
          schema_version: READ_ONLY_SOURCE_DISCOVERY_VERSION,
          discovery_ref: `epo-ops:publication:${publication.publicationNumber}`,
          provider_id: PROVIDER_ID,
          external_id: `publication:${publication.publicationNumber}`,
          source_kind: "patent_publication",
          title: publication.title,
          canonical_url: publication.canonicalUrl,
          published_on: publication.publicationDate,
          not_citable: true as const,
          metadata: metadata(publication),
        }));
        const truncated = parsed.totalResults > request.page! * request.page_size!;
        return {
          discoveries,
          importCandidates: [],
          coverage: {
            schema_version: READ_ONLY_SOURCE_COVERAGE_VERSION,
            request_ref: request.request_ref,
            status: truncated ? "incomplete" : "complete",
            pages_examined: 1,
            items_examined: discoveries.length,
            truncated,
            gaps: truncated
              ? [
                  {
                    code: "pagination_truncated" as const,
                    detail:
                      "More EPO OPS results remain outside this bounded page.",
                  },
                ]
              : [],
          },
        };
      }

      const response = readRawSchema.parse(raw);
      const publication = parseEpoOpsSinglePublication(response.biblio_xml);
      const expected = selectedPublication(request);
      if (
        !expected ||
        response.publication_number !== expected ||
        publication.publicationNumber !== expected ||
        !withinRequestedScope(publication, request)
      ) {
        throw new Error("epo_ops_selected_publication_scope_drift");
      }
      const fullText = parseEpoOpsFullText({
        descriptionXml: response.description_xml,
        claimsXml: response.claims_xml,
      });
      const fullTextAvailable = Boolean(
        fullText.description || fullText.claims.length,
      );
      const sourceBody = JSON.stringify(
        {
          schema_version: "epo_ops_publication_source_v1",
          publication,
          description: fullText.description,
          claims: fullText.claims,
        },
        null,
        2,
      );
      if (sourceBody.length > EPO_OPS_MAXIMUM_SOURCE_BODY_CHARS) {
        throw new Error("epo_ops_source_body_limit_exceeded");
      }
      return {
        discoveries: [],
        importCandidates: [
          {
            schema_version: READ_ONLY_SOURCE_SNAPSHOT_VERSION,
            snapshot_ref: `epo-ops:publication:${publication.publicationNumber}`,
            provider_id: PROVIDER_ID,
            external_id: `publication:${publication.publicationNumber}`,
            source_kind: "patent_publication",
            title: publication.title,
            canonical_url: publication.canonicalUrl,
            retrieved_at: now(),
            as_of_date: null,
            content_type: "application/json",
            content_sha256: `sha256:${createHash("sha256")
              .update(sourceBody)
              .digest("hex")}`,
            source_body: sourceBody,
            metadata: metadata(publication, {
              requested_as_of_date: request.as_of_date,
              full_text_available: fullTextAvailable,
              description_available: Boolean(fullText.description),
              claim_count: fullText.claims.length,
            }),
          },
        ],
        coverage: {
          schema_version: READ_ONLY_SOURCE_COVERAGE_VERSION,
          request_ref: request.request_ref,
          status: fullTextAvailable ? "complete" : "incomplete",
          pages_examined: 1,
          items_examined: 1,
          truncated: false,
          gaps: fullTextAvailable
            ? []
            : [
                {
                  code: "full_text_unavailable" as const,
                  detail:
                    "EPO OPS returned bibliographic data without readable claims or description.",
                },
              ],
        },
      };
    },
  };
}
