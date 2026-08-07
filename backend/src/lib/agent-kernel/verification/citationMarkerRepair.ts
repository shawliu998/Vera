/**
 * Plan one server-owned citation-marker-only patch. This module never edits a
 * document and never decides whether prose is legally supported. The caller
 * must first bind one current DOCX Version and prove every supplied quote is
 * one continuous exact substring of its pinned source Version.
 */

export type ExactCitationMarkerSource = Readonly<{
  marker: number;
  sourceDocumentId: string;
  sourceVersionId: string;
  quote: string;
}>;

export type CitationMarkerTextPatch = Readonly<{
  marker: number;
  find: string;
  replace: string;
  contextBefore: string;
  contextAfter: string;
}>;

export type CitationMarkerRepairOutcome =
  | Readonly<{ kind: "repaired"; patch: CitationMarkerTextPatch }>
  | Readonly<{
      kind: "no-repair";
      reason:
        | "no-source-citations"
        | "stale-source-info"
        | "non-contiguous-marker-sequence"
        | "missing-or-duplicate-source-ref"
        | "multiple-missing-markers"
        | "candidate-is-heading"
        | "no-matching-source-citation"
        | "ambiguous-source-citation"
        | "ambiguous-anchor";
    }>;

type Paragraph = Readonly<{
  text: string;
  previous: string;
  next: string;
}>;

type ParagraphStatus =
  | Readonly<{ kind: "missing"; paragraph: Paragraph }>
  | Readonly<{ kind: "marked"; markers: number[] }>
  | Readonly<{ kind: "non-contiguous" }>;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isHeadingOnly(paragraph: string) {
  const trimmed = paragraph.trim();
  if (/[.!?。！？]/.test(trimmed)) return false;
  if (trimmed === trimmed.toUpperCase()) return true;
  return trimmed.length <= 80;
}

function isMaterialParagraph(paragraph: string) {
  const trimmed = paragraph.trim();
  return trimmed.length > 0 && !isHeadingOnly(trimmed);
}

function trailingMarkers(paragraph: string): number[] | null {
  const trimmed = paragraph.trimEnd();
  const trailing = trimmed.match(/(?:\s*\[\d+\])+(?:\s*[.!?。！？])?$/);
  if (!trailing) return null;
  const prose = trimmed.slice(0, trimmed.length - trailing[0].length);
  if (/\[\d+\]/.test(prose)) return null;
  const refs = Array.from(trailing[0].matchAll(/\[(\d+)\]/g), (match) =>
    Number.parseInt(match[1], 10),
  );
  return new Set(refs).size === refs.length ? refs : null;
}

function materialParagraphs(draftText: string) {
  const lines = draftText.split(/\r?\n/);
  return lines.map((text, index) => ({
    text,
    previous: index > 0 ? lines[index - 1] : "",
    next: index + 1 < lines.length ? lines[index + 1] : "",
  }));
}

function analyzeParagraphs(draftText: string): ParagraphStatus[] {
  const statuses: ParagraphStatus[] = [];
  for (const paragraph of materialParagraphs(draftText)) {
    if (!isMaterialParagraph(paragraph.text)) continue;
    const hasMarker = /\[\d+\]/.test(paragraph.text);
    if (!hasMarker) {
      statuses.push({ kind: "missing", paragraph });
      continue;
    }
    const markers = trailingMarkers(paragraph.text);
    if (markers) statuses.push({ kind: "marked", markers });
    else statuses.push({ kind: "non-contiguous" });
  }
  return statuses;
}

/** Remove only inline numeric citation markers, leaving all prose unchanged. */
export function stripInlineCitationMarkers(text: string) {
  return text.replace(/\s*\[\d+\]/g, "");
}

export function citationMarkerPatchPreservesBody(
  before: string,
  after: string,
) {
  return (
    stripInlineCitationMarkers(before) === stripInlineCitationMarkers(after)
  );
}

export function planExactCitationMarkerPatch(input: {
  draftText: string;
  sourceCitations: readonly ExactCitationMarkerSource[];
}): CitationMarkerRepairOutcome {
  if (!input.sourceCitations.length) {
    return { kind: "no-repair", reason: "no-source-citations" };
  }
  for (const citation of input.sourceCitations) {
    if (
      !Number.isSafeInteger(citation.marker) ||
      citation.marker < 1 ||
      !citation.sourceDocumentId ||
      !citation.sourceVersionId ||
      !citation.quote.trim()
    ) {
      return { kind: "no-repair", reason: "stale-source-info" };
    }
  }
  const sortedSourceRefs = input.sourceCitations
    .map((citation) => citation.marker)
    .sort((left, right) => left - right);
  if (
    new Set(sortedSourceRefs).size !== sortedSourceRefs.length ||
    sortedSourceRefs.some((ref, index) => ref !== index + 1)
  ) {
    return { kind: "no-repair", reason: "missing-or-duplicate-source-ref" };
  }

  const statuses = analyzeParagraphs(input.draftText);
  if (statuses.some((status) => status.kind === "non-contiguous")) {
    return { kind: "no-repair", reason: "non-contiguous-marker-sequence" };
  }
  const markedRefs = statuses.flatMap((status) =>
    status.kind === "marked" ? status.markers : [],
  );
  const sourceRefSet = new Set(sortedSourceRefs);
  if (
    new Set(markedRefs).size !== markedRefs.length ||
    markedRefs.some((ref) => !sourceRefSet.has(ref))
  ) {
    return { kind: "no-repair", reason: "non-contiguous-marker-sequence" };
  }
  const missingParagraphs = statuses.flatMap((status) =>
    status.kind === "missing" ? [status.paragraph] : [],
  );
  const missingRefs = sortedSourceRefs.filter(
    (ref) => !markedRefs.includes(ref),
  );
  if (missingParagraphs.length !== 1 || missingRefs.length !== 1) {
    return { kind: "no-repair", reason: "multiple-missing-markers" };
  }
  const refsAfterPatch = statuses.flatMap((status) =>
    status.kind === "marked"
      ? status.markers
      : status.kind === "missing"
        ? [missingRefs[0]]
        : [],
  );
  if (
    refsAfterPatch.length !== sortedSourceRefs.length ||
    refsAfterPatch.some((ref, index) => ref !== sortedSourceRefs[index])
  ) {
    return { kind: "no-repair", reason: "non-contiguous-marker-sequence" };
  }

  const candidate = missingParagraphs[0];
  if (isHeadingOnly(candidate.text)) {
    return { kind: "no-repair", reason: "candidate-is-heading" };
  }
  const matched = input.sourceCitations.filter(
    (citation) =>
      citation.marker === missingRefs[0] &&
      normalizeWhitespace(candidate.text).includes(
        normalizeWhitespace(citation.quote),
      ),
  );
  if (!matched.length) {
    return { kind: "no-repair", reason: "no-matching-source-citation" };
  }
  if (matched.length !== 1) {
    return { kind: "no-repair", reason: "ambiguous-source-citation" };
  }
  const normalizedCandidate = normalizeWhitespace(candidate.text);
  const identicalAnchors = materialParagraphs(input.draftText).filter(
    (paragraph) => normalizeWhitespace(paragraph.text) === normalizedCandidate,
  );
  if (identicalAnchors.length !== 1) {
    return { kind: "no-repair", reason: "ambiguous-anchor" };
  }

  const patch: CitationMarkerTextPatch = {
    marker: matched[0].marker,
    find: candidate.text,
    replace: `${candidate.text} [${matched[0].marker}]`,
    contextBefore: candidate.previous,
    contextAfter: candidate.next,
  };
  const after = input.draftText.replace(candidate.text, patch.replace);
  if (!citationMarkerPatchPreservesBody(input.draftText, after)) {
    return { kind: "no-repair", reason: "ambiguous-anchor" };
  }
  return { kind: "repaired", patch };
}
