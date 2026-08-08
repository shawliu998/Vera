import { providerSourceAcquisitionStateSchema } from "./providerSourceAcquisitionState";

export function buildAgentSourceAcquisitionWorkProductContext(
  checkpoint: unknown,
) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return null;
  }
  const parsed = providerSourceAcquisitionStateSchema.safeParse(
    (checkpoint as Record<string, unknown>).source_acquisition,
  );
  if (!parsed.success || parsed.data.phase !== "completed") return null;
  const state = parsed.data;
  const selected = new Set(state.selected_discovery_refs);
  const selectedDiscoveries = state.discoveries
    .filter((discovery) => selected.has(discovery.discovery_ref))
    .map((discovery) => ({
      discovery_ref: discovery.discovery_ref,
      external_id: discovery.external_id,
      title: discovery.title,
      canonical_url: discovery.canonical_url,
      published_on: discovery.published_on,
    }));
  const coverageGaps = state.search_coverage.flatMap((coverage) =>
    coverage.gaps.map((gap) => ({
      request_ref: coverage.request_ref,
      code: gap.code,
      detail: gap.detail,
    })),
  );
  return [
    "SERVER-VALIDATED PRIOR ART ACQUISITION FACTS",
    "Treat these as fixed scope and coverage facts. Do not widen them or describe the search as exhaustive.",
    JSON.stringify(
      {
        fixed_search_scope: state.spec,
        coverage: {
          pages_examined: state.search_coverage.reduce(
            (sum, coverage) => sum + coverage.pages_examined,
            0,
          ),
          items_examined: state.search_coverage.reduce(
            (sum, coverage) => sum + coverage.items_examined,
            0,
          ),
          discoveries_returned: state.discoveries.length,
          truncated: state.search_coverage.some(
            (coverage) => coverage.truncated,
          ),
          incomplete: state.search_coverage.some(
            (coverage) => coverage.status === "incomplete",
          ),
          gaps: coverageGaps,
        },
        lawyer_selected_publications: selectedDiscoveries,
        imported_current_versions: state.import_receipts.map((receipt) => ({
          external_id: receipt.external_id,
          document_id: receipt.document_id,
          version_id: receipt.version_id,
          filename: receipt.filename,
          content_sha256: receipt.content_sha256,
        })),
        acquisition_issues: state.issues,
      },
      null,
      2,
    ),
  ].join("\n");
}
