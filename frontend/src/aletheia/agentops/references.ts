import {
  createMatterMemoryIndex,
  type MatterMemoryIndex,
  type MatterMemoryObject,
} from "./matterMemory";
import type {
  AgentOpsMatterWorkspace,
  ArtifactRef,
  AuditEvent,
  BigAtReferenceResolutionRecord,
} from "./types";

export const BIG_AT_REFERENCE_TYPES = [
  "Matter",
  "Document",
  "Clause",
  "Evidence",
  "Issue",
  "Risk",
  "Memo",
  "ReviewComment",
  "Gate",
  "Run",
  "Playbook",
  "Skill",
  "EvalCase",
] as const;

export type BigAtReferenceType = (typeof BIG_AT_REFERENCE_TYPES)[number];

export type BigAtParsedReference = {
  raw: string;
  type: BigAtReferenceType;
  selector?: string;
  start: number;
  end: number;
};

export type ReferenceResolutionStatus = "resolved" | "ambiguous" | "missing";

export type ReferencePreview = {
  id: string;
  type: BigAtReferenceType;
  label: string;
  description?: string;
  status?: string;
  matter_id?: string;
  artifact_ref?: ArtifactRef;
  source?: string;
  metadata?: MatterMemoryObject["metadata"];
};

export type BigAtReferenceResolution = {
  reference: BigAtParsedReference;
  status: ReferenceResolutionStatus;
  matches: ReferencePreview[];
  message?: string;
};

export type BigAtAutocompleteCandidate = {
  type: BigAtReferenceType;
  label: string;
  insertion_text: string;
  description?: string;
  status?: string;
  artifact_ref?: ArtifactRef;
};

export type BigAtReferenceSourceOwner = {
  artifact_type:
    | "draft_memo"
    | "review_comment"
    | "audit_event"
    | "agent_run"
    | "matter_memory"
    | "work_product";
  id: string;
};

export type BigAtReferenceAuditCandidate = {
  raw: string;
  type: BigAtReferenceType;
  status: ReferenceResolutionStatus;
  source_text_owner: BigAtReferenceSourceOwner;
  resolved_artifact_refs: ArtifactRef[];
  candidate_artifact_refs: ArtifactRef[];
  required_review_action?: string;
};

function referenceBoundary(value: string | undefined) {
  return !value || !/[A-Za-z0-9_]/.test(value);
}

export function normalizeReferenceSelector(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[:#.\s]+/, "")
    .replace(/\.[a-z0-9]+$/i, (extension) => ` ${extension.slice(1)}`)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitReferenceToken(token: string) {
  const sortedTypes = [...BIG_AT_REFERENCE_TYPES].sort((a, b) => b.length - a.length);
  for (const type of sortedTypes) {
    if (!token.toLowerCase().startsWith(type.toLowerCase())) {
      continue;
    }

    const rest = token.slice(type.length);
    if (rest.length === 0 || /^[:#._-]/.test(rest)) {
      return {
        type,
        selector: rest.length ? rest.replace(/^[:#._-]+/, "") : undefined,
      };
    }
  }

  return undefined;
}

export function parseBigAtReferences(text: string): BigAtParsedReference[] {
  const references: BigAtParsedReference[] = [];
  const pattern = /@([A-Za-z][A-Za-z0-9]*(?:(?:[:#._-][A-Za-z0-9][A-Za-z0-9._/-]*)?))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const start = match.index;
    const raw = match[0].replace(/[.,;!?)]*$/g, "");
    const end = start + raw.length;
    if (!referenceBoundary(text[start - 1]) || !referenceBoundary(text[end])) {
      continue;
    }

    const parsed = splitReferenceToken(raw.slice(1));
    if (!parsed) {
      continue;
    }

    references.push({
      raw,
      type: parsed.type,
      selector: parsed.selector,
      start,
      end,
    });
  }

  return references;
}

function previewFromMemoryObject(entry: MatterMemoryObject): ReferencePreview {
  return {
    id: entry.id,
    type: entry.reference_type,
    label: entry.title,
    description: entry.subtitle,
    status: entry.status,
    matter_id: entry.matter_id,
    artifact_ref: entry.artifact_ref,
    source: entry.source,
    metadata: entry.metadata,
  };
}

function scoreEntry(entry: MatterMemoryObject, selector: string) {
  const normalizedSelector = normalizeReferenceSelector(selector);
  if (!normalizedSelector) {
    return 0;
  }

  const aliases = [entry.id, entry.title, entry.subtitle, ...entry.aliases]
    .filter((value): value is string => Boolean(value))
    .map(normalizeReferenceSelector);

  if (aliases.some((alias) => alias === normalizedSelector)) {
    return 100;
  }

  if (aliases.some((alias) => alias.endsWith(` ${normalizedSelector}`))) {
    return 90;
  }

  if (aliases.some((alias) => alias.includes(normalizedSelector))) {
    return 75;
  }

  const selectorWords = normalizedSelector.split(" ").filter(Boolean);
  if (
    selectorWords.length > 1 &&
    aliases.some((alias) => selectorWords.every((word) => alias.includes(word)))
  ) {
    return 60;
  }

  return 0;
}

function entryInsertionText(entry: MatterMemoryObject) {
  return `@${entry.reference_type}:${entry.id}`;
}

export function createBigAtAutocompleteCandidates(
  query: string,
  workspaceOrIndex: AgentOpsMatterWorkspace | MatterMemoryIndex,
  limit = 10,
): BigAtAutocompleteCandidate[] {
  const index =
    "by_type" in workspaceOrIndex
      ? workspaceOrIndex
      : createMatterMemoryIndex(workspaceOrIndex);
  const rawQuery = query.trim().replace(/^@/, "");
  const parsed = splitReferenceToken(rawQuery);
  const normalizedQuery = normalizeReferenceSelector(rawQuery);
  const entries = parsed
    ? index.by_type.get(parsed.type) ?? []
    : index.entries.filter((entry) =>
        entry.reference_type.toLowerCase().startsWith(rawQuery.toLowerCase()),
      );

  const scored = entries
    .map((entry) => {
      const selectorScore = parsed?.selector ? scoreEntry(entry, parsed.selector) : 0;
      const typeScore =
        !parsed && entry.reference_type.toLowerCase().startsWith(normalizedQuery)
          ? 50
          : 0;
      return { entry, score: selectorScore || typeScore || 1 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit);

  return scored.map(({ entry }) => ({
    type: entry.reference_type,
    label: entry.title,
    insertion_text: entryInsertionText(entry),
    description: entry.subtitle,
    status: entry.status,
    artifact_ref: entry.artifact_ref,
  }));
}

export function resolveBigAtReference(
  reference: BigAtParsedReference,
  index: MatterMemoryIndex,
): BigAtReferenceResolution {
  const entries = index.by_type.get(reference.type) ?? [];
  if (entries.length === 0) {
    return {
      reference,
      status: "missing",
      matches: [],
      message: `${reference.raw} has no local ${reference.type} objects in matter memory.`,
    };
  }

  if (!reference.selector) {
    if (entries.length === 1) {
      return {
        reference,
        status: "resolved",
        matches: [previewFromMemoryObject(entries[0])],
      };
    }

    return {
      reference,
      status: "ambiguous",
      matches: entries.slice(0, 8).map(previewFromMemoryObject),
      message: `${reference.raw} matched ${entries.length} ${reference.type} objects. Add a selector such as ${reference.raw}:id.`,
    };
  }

  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, reference.selector ?? "") }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));

  if (scored.length === 0) {
    return {
      reference,
      status: "missing",
      matches: [],
      message: `${reference.raw} did not match a local ${reference.type} object.`,
    };
  }

  const bestScore = scored[0].score;
  const bestMatches = scored
    .filter((item) => item.score === bestScore)
    .map((item) => previewFromMemoryObject(item.entry));

  return {
    reference,
    status: bestMatches.length === 1 ? "resolved" : "ambiguous",
    matches: bestMatches,
    message:
      bestMatches.length === 1
        ? undefined
        : `${reference.raw} matched ${bestMatches.length} ${reference.type} objects equally.`,
  };
}

export function resolveBigAtReferences(
  text: string,
  workspaceOrIndex: AgentOpsMatterWorkspace | MatterMemoryIndex,
): BigAtReferenceResolution[] {
  const index =
    "by_type" in workspaceOrIndex
      ? workspaceOrIndex
      : createMatterMemoryIndex(workspaceOrIndex);

  return parseBigAtReferences(text).map((reference) =>
    resolveBigAtReference(reference, index),
  );
}

export function artifactRefsFromResolutions(
  resolutions: BigAtReferenceResolution[],
): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const resolution of resolutions) {
    if (resolution.status !== "resolved") {
      continue;
    }

    const artifactRef = resolution.matches[0]?.artifact_ref;
    if (artifactRef) {
      byId.set(`${artifactRef.type}:${artifactRef.id}`, artifactRef);
    }
  }

  return Array.from(byId.values());
}

export function resolutionRecordsFromResolutions(
  resolutions: BigAtReferenceResolution[],
): BigAtReferenceResolutionRecord[] {
  return resolutions.map((resolution) => {
    const refs = resolution.matches
      .map((match) => match.artifact_ref)
      .filter((artifactRef): artifactRef is ArtifactRef => Boolean(artifactRef));

    return {
      raw: resolution.reference.raw,
      type: resolution.reference.type,
      status: resolution.status,
      resolved_artifact_refs: resolution.status === "resolved" ? refs.slice(0, 1) : [],
      candidate_artifact_refs: resolution.status === "ambiguous" ? refs : undefined,
      message: resolution.message,
    };
  });
}

export function auditCandidatesFromResolutions(
  resolutions: BigAtReferenceResolution[],
  sourceTextOwner: BigAtReferenceSourceOwner,
): BigAtReferenceAuditCandidate[] {
  return resolutions.map((resolution) => {
    const artifactRefs = resolution.matches
      .map((match) => match.artifact_ref)
      .filter((artifactRef): artifactRef is ArtifactRef => Boolean(artifactRef));
    const resolvedArtifactRefs =
      resolution.status === "resolved" ? artifactRefs.slice(0, 1) : [];
    const candidateArtifactRefs =
      resolution.status === "ambiguous" ? artifactRefs : [];
    const requiredReviewAction =
      resolution.status === "ambiguous"
        ? "Choose a more specific Big @ selector before using this reference in a draft, gate, export, or eval record."
        : resolution.status === "missing"
          ? "Resolve or remove the missing Big @ reference before professional reliance."
          : undefined;

    return {
      raw: resolution.reference.raw,
      type: resolution.reference.type,
      status: resolution.status,
      source_text_owner: sourceTextOwner,
      resolved_artifact_refs: resolvedArtifactRefs,
      candidate_artifact_refs: candidateArtifactRefs,
      required_review_action: requiredReviewAction,
    };
  });
}

export function linkBigAtReferences<
  T extends {
    big_at_references?: string[];
    referenced_artifacts?: ArtifactRef[];
    big_at_resolution_records?: BigAtReferenceResolutionRecord[];
  },
>(
  artifact: T,
  text: string,
  workspaceOrIndex: AgentOpsMatterWorkspace | MatterMemoryIndex,
): T {
  const parsed = parseBigAtReferences(text);
  const index =
    "by_type" in workspaceOrIndex
      ? workspaceOrIndex
      : createMatterMemoryIndex(workspaceOrIndex);
  const resolutions = parsed.map((reference) =>
    resolveBigAtReference(reference, index),
  );

  return {
    ...artifact,
    big_at_references: parsed.map((reference) => reference.raw),
    referenced_artifacts: artifactRefsFromResolutions(resolutions),
    big_at_resolution_records: resolutionRecordsFromResolutions(resolutions),
  };
}

export function withAuditEventReferences(
  event: AuditEvent,
  note: string,
  workspaceOrIndex: AgentOpsMatterWorkspace | MatterMemoryIndex,
): AuditEvent {
  return linkBigAtReferences(event, note, workspaceOrIndex);
}
