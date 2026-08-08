import type { AgentCheckpoint } from "@/app/types/agent";

export type AgentSourceDiscovery = {
  discoveryRef: string;
  externalId: string;
  title: string;
  canonicalUrl: string;
  publishedOn: string | null;
};

export type AgentSourceSelection = {
  maximumSelections: number;
  discoveries: AgentSourceDiscovery[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function httpsUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function getAgentSourceSelection(
  checkpoint: AgentCheckpoint | null,
): AgentSourceSelection | null {
  const state = record(checkpoint?.source_acquisition);
  const spec = record(state?.spec);
  if (
    state?.schema_version !== "provider_source_acquisition_state_v1" ||
    state.phase !== "selection_required" ||
    !spec ||
    spec.schema_version !== "provider_source_acquisition_spec_v1" ||
    !Number.isInteger(spec.maximum_selections) ||
    (spec.maximum_selections as number) < 1 ||
    (spec.maximum_selections as number) > 20 ||
    !Array.isArray(state.discoveries)
  ) {
    return null;
  }
  const discoveries = state.discoveries.flatMap((value) => {
    const item = record(value);
    const canonicalUrl = httpsUrl(item?.canonical_url);
    if (
      item?.schema_version !== "read_only_source_discovery_v1" ||
      typeof item.discovery_ref !== "string" ||
      !item.discovery_ref.trim() ||
      typeof item.external_id !== "string" ||
      !item.external_id.trim() ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      !canonicalUrl ||
      (item.published_on !== null &&
        item.published_on !== undefined &&
        typeof item.published_on !== "string")
    ) {
      return [];
    }
    return [
      {
        discoveryRef: item.discovery_ref,
        externalId: item.external_id,
        title: item.title,
        canonicalUrl,
        publishedOn:
          typeof item.published_on === "string" ? item.published_on : null,
      },
    ];
  });
  const refs = discoveries.map((item) => item.discoveryRef);
  if (
    discoveries.length === 0 ||
    discoveries.length !== state.discoveries.length ||
    new Set(refs).size !== refs.length
  ) {
    return null;
  }
  return {
    maximumSelections: spec.maximum_selections as number,
    discoveries,
  };
}
