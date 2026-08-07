import type { AssistantEvent } from "../shared/types";
import type { TRCitationAnnotation } from "@/app/lib/mikeApi";
import {
    appendAssistantEvent,
    appendThinkingPlaceholder,
    parseCourtlistenerCaseSearches,
    parseCourtlistenerEventCases,
    updateLastMatchingEvent,
} from "./tabularChatEvents";
import type { TabularChatStreamEvent } from "./tabularChatStream";

export interface TabularToolTransition {
    handled: boolean;
    events: AssistantEvent[];
}

export function parseTabularCitationAnnotations(
    value: unknown,
): TRCitationAnnotation[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        if (
            row.type !== "tabular_citation" ||
            typeof row.ref !== "number" ||
            typeof row.col_index !== "number" ||
            typeof row.row_index !== "number" ||
            typeof row.col_name !== "string" ||
            typeof row.doc_name !== "string" ||
            typeof row.quote !== "string"
        ) {
            return [];
        }
        return [
            {
                type: "tabular_citation" as const,
                ref: row.ref,
                col_index: row.col_index,
                row_index: row.row_index,
                col_name: row.col_name,
                doc_name: row.doc_name,
                quote: row.quote,
            },
        ];
    });
}

function numbers(value: unknown): number[] {
    return Array.isArray(value)
        ? value.filter(
              (item: unknown): item is number => typeof item === "number",
          )
        : [];
}

function stringOrEmpty(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function optionalError(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function finishToolEvent(
    events: AssistantEvent[],
    predicate: (event: AssistantEvent) => boolean,
    updater: (event: AssistantEvent) => AssistantEvent,
): AssistantEvent[] {
    const updated = updateLastMatchingEvent(events, predicate, updater).events;
    return appendThinkingPlaceholder(updated);
}

function parseCaseOpinions(
    value: unknown,
): Extract<AssistantEvent, { type: "case_opinions" }>["case"] | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const row = value as Record<string, unknown>;
    if (!Array.isArray(row.opinions)) return null;
    const opinions = row.opinions.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const opinion = item as Record<string, unknown>;
        return [
            {
                opinionId: numberOrNull(opinion.opinionId),
                apiUrl:
                    typeof opinion.apiUrl === "string"
                        ? opinion.apiUrl
                        : null,
                type:
                    typeof opinion.type === "string" ? opinion.type : null,
                author:
                    typeof opinion.author === "string" ? opinion.author : null,
                url: typeof opinion.url === "string" ? opinion.url : null,
                text:
                    typeof opinion.text === "string" ? opinion.text : null,
                html:
                    typeof opinion.html === "string" ? opinion.html : null,
            },
        ];
    });
    return {
        id: numberOrNull(row.id),
        caseName: typeof row.caseName === "string" ? row.caseName : null,
        dateFiled: typeof row.dateFiled === "string" ? row.dateFiled : null,
        citations: Array.isArray(row.citations)
            ? row.citations.filter(
                  (item: unknown): item is string => typeof item === "string",
              )
            : [],
        url: typeof row.url === "string" ? row.url : null,
        pdfUrl: typeof row.pdfUrl === "string" ? row.pdfUrl : null,
        opinions,
    };
}

export function reduceTabularToolEvent(
    events: AssistantEvent[],
    data: TabularChatStreamEvent,
): TabularToolTransition {
    if (data.type === "courtlistener_search_case_law_start") {
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "courtlistener_search_case_law",
                query: stringOrEmpty(data.query),
                isStreaming: true,
            }),
        };
    }

    if (data.type === "courtlistener_search_case_law") {
        const query = stringOrEmpty(data.query);
        return {
            handled: true,
            events: finishToolEvent(
                events,
                (event) =>
                    event.type === "courtlistener_search_case_law" &&
                    event.query === query &&
                    !!event.isStreaming,
                () => ({
                    type: "courtlistener_search_case_law",
                    query,
                    result_count:
                        typeof data.result_count === "number"
                            ? data.result_count
                            : 0,
                    error: optionalError(data.error),
                    isStreaming: false,
                }),
            ),
        };
    }

    if (data.type === "courtlistener_get_cases_start") {
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "courtlistener_get_cases",
                cluster_ids: numbers(data.cluster_ids),
                isStreaming: true,
            }),
        };
    }

    if (data.type === "courtlistener_get_cases") {
        return {
            handled: true,
            events: finishToolEvent(
                events,
                (event) =>
                    event.type === "courtlistener_get_cases" &&
                    !!event.isStreaming,
                () => ({
                    type: "courtlistener_get_cases",
                    cluster_ids: numbers(data.cluster_ids),
                    case_count:
                        typeof data.case_count === "number"
                            ? data.case_count
                            : 0,
                    opinion_count:
                        typeof data.opinion_count === "number"
                            ? data.opinion_count
                            : 0,
                    cases: parseCourtlistenerEventCases(data.cases),
                    error: optionalError(data.error),
                    isStreaming: false,
                }),
            ),
        };
    }

    if (data.type === "courtlistener_find_in_case_start") {
        const searches = parseCourtlistenerCaseSearches(data.searches);
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "courtlistener_find_in_case",
                cluster_id: searches?.length
                    ? null
                    : numberOrNull(data.cluster_id),
                query: searches?.length ? "" : stringOrEmpty(data.query),
                searches,
                isStreaming: true,
            }),
        };
    }

    if (data.type === "courtlistener_find_in_case") {
        const searches = parseCourtlistenerCaseSearches(data.searches);
        const clusterId = searches?.length
            ? null
            : numberOrNull(data.cluster_id);
        const query = searches?.length ? "" : stringOrEmpty(data.query);
        return {
            handled: true,
            events: finishToolEvent(
                events,
                (event) =>
                    event.type === "courtlistener_find_in_case" &&
                    (searches?.length
                        ? Array.isArray(event.searches)
                        : event.cluster_id === clusterId &&
                          event.query === query) &&
                    !!event.isStreaming,
                () => ({
                    type: "courtlistener_find_in_case",
                    cluster_id: clusterId,
                    query,
                    total_matches:
                        typeof data.total_matches === "number"
                            ? data.total_matches
                            : 0,
                    searches,
                    case_name:
                        typeof data.case_name === "string"
                            ? data.case_name
                            : null,
                    citation:
                        typeof data.citation === "string"
                            ? data.citation
                            : null,
                    error: optionalError(data.error),
                    isStreaming: false,
                }),
            ),
        };
    }

    if (data.type === "courtlistener_read_case_start") {
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "courtlistener_read_case",
                cluster_id: numberOrNull(data.cluster_id),
                isStreaming: true,
            }),
        };
    }

    if (data.type === "courtlistener_read_case") {
        const clusterId = numberOrNull(data.cluster_id);
        return {
            handled: true,
            events: finishToolEvent(
                events,
                (event) =>
                    event.type === "courtlistener_read_case" &&
                    event.cluster_id === clusterId &&
                    !!event.isStreaming,
                () => ({
                    type: "courtlistener_read_case",
                    cluster_id: clusterId,
                    case_name:
                        typeof data.case_name === "string"
                            ? data.case_name
                            : null,
                    citation:
                        typeof data.citation === "string"
                            ? data.citation
                            : null,
                    opinion_count:
                        typeof data.opinion_count === "number"
                            ? data.opinion_count
                            : 0,
                    error: optionalError(data.error),
                    isStreaming: false,
                }),
            ),
        };
    }

    if (data.type === "courtlistener_verify_citations_start") {
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "courtlistener_verify_citations",
                citation_count:
                    typeof data.citation_count === "number"
                        ? data.citation_count
                        : 0,
                isStreaming: true,
            }),
        };
    }

    if (data.type === "courtlistener_verify_citations") {
        return {
            handled: true,
            events: finishToolEvent(
                events,
                (event) =>
                    event.type === "courtlistener_verify_citations" &&
                    !!event.isStreaming,
                () => ({
                    type: "courtlistener_verify_citations",
                    citation_count:
                        typeof data.citation_count === "number"
                            ? data.citation_count
                            : 0,
                    match_count:
                        typeof data.match_count === "number"
                            ? data.match_count
                            : 0,
                    error: optionalError(data.error),
                    isStreaming: false,
                }),
            ),
        };
    }

    if (data.type === "case_citation") {
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "case_citation",
                cluster_id: numberOrNull(data.cluster_id),
                case_name:
                    typeof data.case_name === "string" ? data.case_name : null,
                citation:
                    typeof data.citation === "string" ? data.citation : null,
                url: stringOrEmpty(data.url),
            }),
        };
    }

    if (data.type === "case_opinions") {
        const caseData = parseCaseOpinions(data.case);
        return {
            handled: true,
            events: caseData
                ? appendAssistantEvent(events, {
                      type: "case_opinions",
                      cluster_id:
                          typeof data.cluster_id === "number"
                              ? data.cluster_id
                              : 0,
                      case: caseData,
                  })
                : events,
        };
    }

    if (data.type === "doc_read_start") {
        if (typeof data.filename !== "string" || !data.filename) {
            return { handled: true, events };
        }
        return {
            handled: true,
            events: appendAssistantEvent(events, {
                type: "doc_read",
                filename: data.filename,
                isStreaming: true,
            }),
        };
    }

    if (data.type === "doc_read") {
        if (typeof data.filename !== "string" || !data.filename) {
            return { handled: true, events };
        }
        return {
            handled: true,
            events: finishToolEvent(
                events,
                (event) =>
                    event.type === "doc_read" &&
                    event.filename === data.filename &&
                    !!event.isStreaming,
                (event) => ({ ...event, isStreaming: false }),
            ),
        };
    }

    return { handled: false, events };
}
