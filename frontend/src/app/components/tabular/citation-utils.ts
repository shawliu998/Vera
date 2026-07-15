// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/citation-utils.ts. Vera uses durable,
// structured source records instead of trusting citation markers in model text.
import type { VeraTabularSource } from "@/app/lib/veraTabularApi";

export function tabularSourcePageLabel(source: VeraTabularSource): string | null {
  if (source.page_start === null || source.page_end === null) return null;
  return source.page_start === source.page_end
    ? String(source.page_start)
    : `${source.page_start}–${source.page_end}`;
}

export function tabularSourceOffsetLabel(
  source: VeraTabularSource,
): string | null {
  if (source.start_offset === null || source.end_offset === null) return null;
  return `${source.start_offset}–${source.end_offset}`;
}

export function sourceIdentity(source: VeraTabularSource): string {
  return [
    source.document_id,
    source.version_id ?? "",
    source.chunk_id ?? "",
    source.start_offset ?? "",
    source.end_offset ?? "",
  ].join(":");
}
