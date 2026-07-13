import type {
  AletheiaSearchResult,
  AletheiaSearchResultKind,
} from "../app/lib/aletheiaApi";

export const SEARCH_RESULT_KIND_ORDER: AletheiaSearchResultKind[] = [
  "matter",
  "document",
  "fact",
  "position",
  "deadline",
  "task",
  "work_product",
];

export type AletheiaSearchResultGroup = {
  kind: AletheiaSearchResultKind;
  results: AletheiaSearchResult[];
};

export function groupAletheiaSearchResults(
  results: AletheiaSearchResult[],
): AletheiaSearchResultGroup[] {
  return SEARCH_RESULT_KIND_ORDER.map((kind) => ({
    kind,
    results: results.filter((result) => result.kind === kind),
  })).filter((group) => group.results.length > 0);
}

export function movePaletteSelection(
  currentIndex: number,
  itemCount: number,
  direction: 1 | -1,
) {
  if (itemCount <= 0) return 0;
  return (currentIndex + direction + itemCount) % itemCount;
}
