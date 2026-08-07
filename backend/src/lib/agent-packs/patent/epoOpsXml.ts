import { XMLParser } from "fast-xml-parser";

export const EPO_OPS_SOURCE_HOST = "worldwide.espacenet.com";
export const EPO_OPS_MAXIMUM_SOURCE_BODY_CHARS = 1_900_000;
export const EPO_OPS_MAXIMUM_RAW_XML_CHARS = 2_000_000;
export const EPO_OPS_PUBLICATION_NUMBER = /^[A-Z]{2}[A-Z0-9./-]{1,38}$/;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array<T>(value: T | T[] | null | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function scalarText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  const node = record(value);
  return typeof node["#text"] === "string" || typeof node["#text"] === "number"
    ? String(node["#text"]).trim()
    : "";
}

function normalizedSpace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function deepText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepText).filter(Boolean).join(" ");
  }
  return Object.entries(record(value))
    .filter(([key]) => !key.startsWith("@"))
    .map(([, child]) => deepText(child))
    .filter(Boolean)
    .join(" ");
}

function collectNodes(value: unknown, key: string, output: unknown[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNodes(item, key, output));
    return output;
  }
  for (const [childKey, child] of Object.entries(record(value))) {
    if (childKey === key) output.push(...array(child));
    collectNodes(child, key, output);
  }
  return output;
}

function firstText(value: unknown, key: string): string | null {
  for (const node of collectNodes(value, key)) {
    const text = normalizedSpace(deepText(node));
    if (text) return text;
  }
  return null;
}

function unique(values: string[], maximum = 100) {
  return [...new Set(values.map(normalizedSpace).filter(Boolean))].slice(
    0,
    maximum,
  );
}

function normalizeDate(value: unknown): string | null {
  const raw = scalarText(value).replaceAll("-", "");
  if (!/^\d{8}$/.test(raw)) return null;
  const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

function parseXml(xml: string): unknown {
  if (!xml.trim() || xml.length > EPO_OPS_MAXIMUM_RAW_XML_CHARS) {
    throw new Error("epo_ops_xml_invalid");
  }
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    removeNSPrefix: true,
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  }).parse(xml);
}

function preferredLanguageNode(value: unknown): unknown | null {
  const nodes = array(value);
  return (
    nodes.find((node) => record(node)["@lang"] === "en") ?? nodes[0] ?? null
  );
}

function documentIdByType(value: unknown, type: string): JsonRecord {
  const ids = collectNodes(value, "document-id").map(record);
  return ids.find((id) => id["@document-id-type"] === type) ?? ids[0] ?? {};
}

function partyNames(value: unknown, partyKey: "applicant" | "inventor") {
  const names: string[] = [];
  for (const party of collectNodes(value, partyKey)) {
    const preferred = firstText(record(party)[`${partyKey}-name`], "name");
    const fallback = firstText(party, "name");
    if (preferred || fallback) names.push(preferred ?? fallback!);
  }
  return unique(names);
}

function classificationValues(value: unknown) {
  const values: string[] = [];
  for (const key of ["classification-ipcr", "classification-cpc"]) {
    for (const classification of collectNodes(value, key)) {
      const symbol =
        firstText(classification, "text") ??
        firstText(classification, "classification-symbol");
      if (symbol) values.push(symbol.replace(/\s+/g, ""));
    }
  }
  return unique(values);
}

function canonicalPublicationUrl(publicationNumber: string) {
  return `https://${EPO_OPS_SOURCE_HOST}/patent/search?q=pn%3D${encodeURIComponent(publicationNumber)}`;
}

export function normalizeEpoOpsPublicationNumber(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9./-]/g, "");
}

export type EpoOpsPublicationSummary = {
  publicationNumber: string;
  jurisdiction: string;
  kindCode: string | null;
  title: string;
  abstract: string | null;
  publicationDate: string | null;
  filingDate: string | null;
  priorityDates: string[];
  applicants: string[];
  inventors: string[];
  classifications: string[];
  familyId: string | null;
  canonicalUrl: string;
};

function summaryFromExchangeDocument(
  rawDocument: unknown,
): EpoOpsPublicationSummary | null {
  const exchange = record(rawDocument);
  const biblio = record(exchange["bibliographic-data"]);
  const docdb = documentIdByType(
    biblio["publication-reference"] ?? exchange,
    "docdb",
  );
  const jurisdiction = (
    scalarText(exchange["@country"]) || scalarText(docdb.country)
  ).toUpperCase();
  const docNumber =
    scalarText(exchange["@doc-number"]) || scalarText(docdb["doc-number"]);
  const kindCode =
    scalarText(exchange["@kind"]) || scalarText(docdb.kind) || null;
  if (!jurisdiction || !docNumber) return null;
  const publicationNumber = normalizeEpoOpsPublicationNumber(
    `${jurisdiction}${docNumber}${kindCode ?? ""}`,
  );
  if (!EPO_OPS_PUBLICATION_NUMBER.test(publicationNumber)) return null;

  const titleNode = preferredLanguageNode(biblio["invention-title"]);
  const abstractNode = preferredLanguageNode(exchange.abstract);
  const applicationId = documentIdByType(
    biblio["application-reference"],
    "docdb",
  );
  const priorityDates = collectNodes(biblio, "priority-claim")
    .map((priority) => normalizeDate(documentIdByType(priority, "docdb").date))
    .filter((date): date is string => Boolean(date));

  return {
    publicationNumber,
    jurisdiction,
    kindCode,
    title: normalizedSpace(deepText(titleNode)) || publicationNumber,
    abstract: abstractNode
      ? normalizedSpace(deepText(abstractNode)) || null
      : null,
    publicationDate: normalizeDate(docdb.date),
    filingDate: normalizeDate(applicationId.date),
    priorityDates: unique(priorityDates),
    applicants: partyNames(biblio, "applicant"),
    inventors: partyNames(biblio, "inventor"),
    classifications: classificationValues(biblio),
    familyId: scalarText(exchange["@family-id"]) || null,
    canonicalUrl: canonicalPublicationUrl(publicationNumber),
  };
}

export function parseEpoOpsSearchResponse(xml: string) {
  const parsed = parseXml(xml);
  const searchNode = collectNodes(parsed, "biblio-search")[0];
  if (!searchNode) throw new Error("epo_ops_search_result_malformed");
  const rawTotal = scalarText(record(searchNode)["@total-result-count"]);
  const totalResults = Number(rawTotal);
  if (!/^\d+$/.test(rawTotal) || !Number.isSafeInteger(totalResults)) {
    throw new Error("epo_ops_total_result_count_malformed");
  }
  const results = collectNodes(parsed, "exchange-document")
    .map(summaryFromExchangeDocument)
    .filter((value): value is EpoOpsPublicationSummary => Boolean(value));
  return { totalResults, results };
}

export function parseEpoOpsSinglePublication(xml: string) {
  for (const document of collectNodes(parseXml(xml), "exchange-document")) {
    const summary = summaryFromExchangeDocument(document);
    if (summary) return summary;
  }
  throw new Error("epo_ops_biblio_result_malformed");
}

export function parseEpoOpsFullText(input: {
  descriptionXml: string | null;
  claimsXml: string | null;
}) {
  const descriptionParsed = input.descriptionXml
    ? parseXml(input.descriptionXml)
    : null;
  const claimsParsed = input.claimsXml ? parseXml(input.claimsXml) : null;
  const claims = unique(
    collectNodes(claimsParsed, "claim")
      .map((claim) => normalizedSpace(deepText(claim)))
      .filter(Boolean),
  );
  let remaining = EPO_OPS_MAXIMUM_SOURCE_BODY_CHARS - 100_000;
  const boundedClaims: string[] = [];
  for (const claim of claims) {
    if (remaining <= 0) break;
    const bounded = claim.slice(0, remaining);
    if (bounded) boundedClaims.push(bounded);
    remaining -= bounded.length;
  }
  const descriptionNode =
    collectNodes(descriptionParsed, "description")[0] ?? null;
  const description = descriptionNode
    ? normalizedSpace(deepText(descriptionNode)).slice(0, remaining) || null
    : null;
  return { description, claims: boundedClaims };
}
