import { createHash } from "node:crypto";
import { z } from "zod";

import {
  getCourtlistenerCaseOpinions,
  searchCourtlistenerCaseLaw,
} from "../../courtlistener";
import {
  READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
  READ_ONLY_SOURCE_COVERAGE_VERSION,
  READ_ONLY_SOURCE_DISCOVERY_VERSION,
  READ_ONLY_SOURCE_SNAPSHOT_VERSION,
  readOnlySourceConnectorPinSchema,
  type ReadOnlySourceConnectorPinV1,
  type ReadOnlySourceOperationV1,
} from "../../agent-kernel/connectors/readOnlySourceContract";
import {
  ReadOnlySourceInvocationError,
  type ReadOnlySourceBoundInvokerV1,
  type ReadOnlySourceNormalizerV1,
} from "../../agent-kernel/connectors/readOnlySourceExecution";

const PROVIDER_ID = "courtlistener";
const CONNECTOR_ID = "research.courtlistener.case-law";
const ENDPOINT_HOST = "www.courtlistener.com";
const MAXIMUM_BODY_CHARS = 50_000;

function digest(contract: string) {
  return `sha256:${createHash("sha256").update(contract).digest("hex")}`;
}

export const COURTLISTENER_SOURCE_CONNECTOR_PIN =
  readOnlySourceConnectorPinSchema.parse({
    schema_version: READ_ONLY_SOURCE_CONNECTOR_PIN_VERSION,
    connector_id: CONNECTOR_ID,
    connector_version: "1.0.0",
    provider_id: PROVIDER_ID,
    provider_version: "rest-v4",
    adapter_id: "vera.research.courtlistener",
    adapter_version: "1.0.0",
    binding: {
      kind: "http",
      operation_id: "courtlistener.case-law.readonly",
      operation_version: "1.0.0",
      input_schema_version: "courtlistener_case_law_request_v1",
      input_schema_digest: digest(
        "operation|query|as_of_date|page|page_size|external_id",
      ),
      output_schema_version: "courtlistener_case_law_response_v1",
      output_schema_digest: digest(
        "search(query,results(clusterId,caseName,citation,court,dateFiled,snippet,url))|read(id,url,opinions,source)",
      ),
    },
    allowed_hosts: [ENDPOINT_HOST],
    allowed_source_hosts: [ENDPOINT_HOST],
    allowed_jurisdictions: ["US"],
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
      maximum_pages: 1,
      maximum_items_per_page: 20,
      maximum_query_chars: 2_000,
      maximum_snapshot_chars: MAXIMUM_BODY_CHARS,
    },
    fixed: true,
    read_only: true,
  });

const nullableText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable();

const searchResultSchema = z
  .object({
    clusterId: z.number().int().positive(),
    caseName: nullableText(1_000),
    citation: nullableText(500),
    court: nullableText(200),
    dateFiled: nullableText(32),
    snippet: nullableText(4_000),
    url: nullableText(2_000),
  })
  .strict();

const searchResponseSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    results: z.array(searchResultSchema).max(20),
  })
  .strict();

const opinionSchema = z
  .object({
    opinionId: z.number().int().positive().nullable(),
    type: nullableText(120),
    author: nullableText(500),
    per_curiam: nullableText(120),
    joined_by_str: nullableText(1_000),
    url: nullableText(2_000),
    text: nullableText(MAXIMUM_BODY_CHARS),
    html: nullableText(MAXIMUM_BODY_CHARS),
  })
  .strict();

const readResponseSchema = z
  .object({
    id: z.number().int().positive(),
    url: nullableText(2_000),
    caseName: nullableText(1_000).optional(),
    dateFiled: nullableText(32).optional(),
    court: nullableText(200).optional(),
    citations: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    pdfUrl: nullableText(2_000).optional(),
    subOpinions: z.array(z.unknown()).max(100).optional(),
    opinions: z.array(opinionSchema).max(100),
    source: z.enum(["api", "bulk"]),
  })
  .strict();

function caseUrl(clusterId: number) {
  return `https://${ENDPOINT_HOST}/opinion/${clusterId}/`;
}

function safeCaseUrl(value: string | null, clusterId: number) {
  if (!value) return caseUrl(clusterId);
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ENDPOINT_HOST ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("courtlistener_source_url_invalid");
  }
  return parsed.toString();
}

function isoDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ? null : value;
}

function metadata(
  entries: Array<[string, string | number | boolean | null | undefined]>,
) {
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== null && entry[1] !== undefined && entry[1] !== "",
    ),
  );
}

function classifyInvocation(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/rate limit|\b429\b|\b5\d\d\b|unavailable/i.test(message)) {
    return "provider_capacity" as const;
  }
  if (/api[_ -]?token|api[_ -]?key|\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(message)) {
    return "provider_configuration" as const;
  }
  return "provider_network" as const;
}

type SearchPrimitive = typeof searchCourtlistenerCaseLaw;
type ReadPrimitive = typeof getCourtlistenerCaseOpinions;

export function createCourtListenerSourceInvoker(input: {
  operation: Extract<ReadOnlySourceOperationV1, "search" | "read_snapshot">;
  apiToken: string;
  search?: SearchPrimitive;
  read?: ReadPrimitive;
}): ReadOnlySourceBoundInvokerV1 {
  const search = input.search ?? searchCourtlistenerCaseLaw;
  const read = input.read ?? getCourtlistenerCaseOpinions;
  return {
    connectorId: COURTLISTENER_SOURCE_CONNECTOR_PIN.connector_id,
    host: ENDPOINT_HOST,
    binding: COURTLISTENER_SOURCE_CONNECTOR_PIN.binding,
    async invoke(payload, options) {
      try {
        const raw =
          input.operation === "search"
            ? await search({
                query: String(payload.query),
                filedBefore: String(payload.as_of_date),
                limit: Number(payload.page_size),
                apiToken: input.apiToken,
                signal: options.signal,
              })
            : await read({
                clusterId: Number(payload.external_id),
                includeFullText: true,
                maxChars: MAXIMUM_BODY_CHARS,
                apiToken: input.apiToken,
                signal: options.signal,
              });
        if (
          raw &&
          typeof raw === "object" &&
          !Array.isArray(raw) &&
          typeof (raw as Record<string, unknown>).error === "string"
        ) {
          throw new ReadOnlySourceInvocationError("provider_protocol");
        }
        return raw;
      } catch (error) {
        if (error instanceof ReadOnlySourceInvocationError) throw error;
        throw new ReadOnlySourceInvocationError(classifyInvocation(error));
      }
    },
  };
}

export function createCourtListenerSourceNormalizer(input: {
  now?: () => string;
  pin?: ReadOnlySourceConnectorPinV1;
} = {}): ReadOnlySourceNormalizerV1 {
  const pin = input.pin ?? COURTLISTENER_SOURCE_CONNECTOR_PIN;
  const now = input.now ?? (() => new Date().toISOString());
  return {
    pin,
    async normalize({ raw, request }) {
      if (request.operation === "search") {
        const response = searchResponseSchema.parse(raw);
        const discoveries = response.results.map((result) => ({
          schema_version: READ_ONLY_SOURCE_DISCOVERY_VERSION,
          discovery_ref: `courtlistener:cluster:${result.clusterId}`,
          provider_id: PROVIDER_ID,
          external_id: String(result.clusterId),
          source_kind: "case_law",
          title: result.caseName ?? `CourtListener case ${result.clusterId}`,
          canonical_url: safeCaseUrl(result.url, result.clusterId),
          published_on: isoDate(result.dateFiled),
          not_citable: true as const,
          metadata: metadata([
            ["citation", result.citation],
            ["court", result.court],
          ]),
        }));
        const truncated = discoveries.length >= request.page_size!;
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
                    code: "result_limit_reached" as const,
                    detail:
                      "The provider primitive does not expose a continuation cursor.",
                  },
                ]
              : [],
          },
        };
      }

      const response = readResponseSchema.parse(raw);
      const sourceBody = response.opinions
        .map((opinion) => opinion.text)
        .filter((value): value is string => Boolean(value))
        .join("\n\n")
        .trim();
      if (!sourceBody) {
        return {
          discoveries: [],
          importCandidates: [],
          coverage: {
            schema_version: READ_ONLY_SOURCE_COVERAGE_VERSION,
            request_ref: request.request_ref,
            status: "incomplete",
            pages_examined: 1,
            items_examined: 0,
            truncated: false,
            gaps: [
              {
                code: "snapshot_unavailable",
                detail: "The provider returned no readable opinion text.",
              },
            ],
          },
        };
      }
      const canonicalUrl = safeCaseUrl(response.url, response.id);
      return {
        discoveries: [],
        importCandidates: [
          {
            schema_version: READ_ONLY_SOURCE_SNAPSHOT_VERSION,
            snapshot_ref: `courtlistener:cluster:${response.id}`,
            provider_id: PROVIDER_ID,
            external_id: String(response.id),
            source_kind: "case_law",
            title: response.caseName ?? `CourtListener opinion ${response.id}`,
            canonical_url: canonicalUrl,
            retrieved_at: now(),
            // CourtListener supplies the opinion text and filing date, but it
            // does not prove that the authority remains current as of the
            // requested date. Do not turn the query boundary into a status
            // assertion.
            as_of_date: null,
            content_type: "text/plain",
            content_sha256: `sha256:${createHash("sha256")
              .update(sourceBody)
              .digest("hex")}`,
            source_body: sourceBody,
            metadata: metadata([
              ["source", response.source],
              ["case_name", response.caseName],
              ["date_filed", response.dateFiled],
              ["requested_as_of_date", request.as_of_date],
              ["opinion_count", response.opinions.length],
              ["citation", response.citations?.join("; ")],
            ]),
          },
        ],
        coverage: {
          schema_version: READ_ONLY_SOURCE_COVERAGE_VERSION,
          request_ref: request.request_ref,
          status: "complete",
          pages_examined: 1,
          items_examined: 1,
          truncated: false,
          gaps: [],
        },
      };
    },
  };
}
