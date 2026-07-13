import { createHash, randomUUID } from "node:crypto";
import type { LocalModelMessage } from "./localModelScheduler";

export const CONTEXT_DIGEST_SCHEMA_VERSION = "aletheia-context-digest-v1";
export const CONTEXT_COMPRESSION_PRIMARY_THRESHOLD = 0.5;
export const CONTEXT_COMPRESSION_HYGIENE_THRESHOLD = 0.85;

export type ContextCompressionMode = "Off" | "Manual" | "Auto";

export type ContextDigestSource = {
  messageId: string;
  sourceHash: string;
  evidenceIds: string[];
  originRun: string;
};

export type ContextDigestSection = {
  text: string;
  evidenceIds: string[];
  sourceHashes: string[];
};

export type ContextDigest = {
  schemaVersion: typeof CONTEXT_DIGEST_SCHEMA_VERSION;
  digestId: string;
  createdAt: string;
  originRun: string;
  model: { id: string; version: string | null };
  priorDigestLink: string | null;
  sources: ContextDigestSource[];
  sections: {
    goal: ContextDigestSection;
    constraints: ContextDigestSection;
    confirmedFacts: ContextDigestSection;
    risks: ContextDigestSection;
    openQuestions: ContextDigestSection;
    progress: ContextDigestSection;
    keyDecisions: ContextDigestSection;
    relevantEvidence: ContextDigestSection;
    nextSteps: ContextDigestSection;
  };
  deterministicallyExcludedToolPairs: string[];
};

export type CompressibleContextMessage = LocalModelMessage & {
  id?: string;
  evidenceIds?: string[];
  originRun?: string;
  /** Tool calls/results are only accepted as a complete pair for deterministic exclusion. */
  toolPairId?: string;
  expiresAt?: string;
};

export type ContextCompressionPolicy = {
  mode: ContextCompressionMode;
  modelId?: string | null;
  modelVersion?: string | null;
  modelContextWindowTokens?: number | null;
  priorDigestLink?: string | null;
  persistDigest?: (digest: ContextDigest) => Promise<{ id: string }>;
};

export class ContextCompressionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "MANUAL_COMPRESSION_REQUIRED"
      | "COMPRESSION_MODEL_UNAVAILABLE"
      | "COMPRESSION_INPUT_TOO_LARGE"
      | "COMPRESSION_FAILED"
      | "COMPRESSION_OUTPUT_INVALID"
      | "COMPRESSION_PERSIST_FAILED",
  ) {
    super(message);
    this.name = "ContextCompressionError";
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function estimateContextTokens(value: unknown) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? {}), "utf8") / 3) + 8;
}

function sourceHash(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function boundedText(value: unknown, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function stringArray(value: unknown, maximum = 100) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 256)))].slice(0, maximum)
    : [];
}

function emptySection(): ContextDigestSection {
  return { text: "", evidenceIds: [], sourceHashes: [] };
}

const SECTION_KEYS = [
  "goal",
  "constraints",
  "confirmedFacts",
  "risks",
  "openQuestions",
  "progress",
  "keyDecisions",
  "relevantEvidence",
  "nextSteps",
] as const;

type SectionKey = (typeof SECTION_KEYS)[number];

function normalizeSection(
  value: unknown,
  allowedEvidenceIds: Set<string>,
  allowedSourceHashes: Set<string>,
) {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    text: boundedText(record.text ?? value),
    evidenceIds: stringArray(record.evidenceIds).filter((id) => allowedEvidenceIds.has(id)),
    sourceHashes: stringArray(record.sourceHashes).filter((hash) => allowedSourceHashes.has(hash)),
  };
}

/**
 * Produces a non-mutating context view. Expired tool data may only be excluded
 * when both members of a tool-call/result pair are present. The caller retains
 * the original inputs and their hashes in the resulting work product.
 */
export function prepareCompressibleContext(
  messages: CompressibleContextMessage[],
  now = new Date(),
) {
  const pairs = new Map<string, CompressibleContextMessage[]>();
  for (const message of messages) {
    if (!message.toolPairId) continue;
    const current = pairs.get(message.toolPairId) ?? [];
    current.push(message);
    pairs.set(message.toolPairId, current);
  }
  const excluded = new Set<string>();
  for (const [pairId, pair] of pairs) {
    const expires = pair.map((item) => item.expiresAt).filter((item): item is string => Boolean(item));
    const expired = expires.length === pair.length && expires.every((value) => !Number.isNaN(Date.parse(value)) && Date.parse(value) <= now.getTime());
    // A pair must contain at least two records; single orphan records are never removed.
    if (pair.length >= 2 && expired) excluded.add(pairId);
  }
  return {
    messages: messages.filter((message) => !message.toolPairId || !excluded.has(message.toolPairId)),
    deterministicallyExcludedToolPairs: [...excluded].sort(),
  };
}

export function buildContextDigestPrompt(args: {
  originRun: string;
  messages: CompressibleContextMessage[];
  sources: ContextDigestSource[];
}) {
  return [
    "Create a ContextDigest for a sensitive professional matter. Return JSON only.",
    "Do not invent facts, evidence identifiers, source hashes, approvals, or decisions.",
    "Use sections goal, constraints, confirmedFacts, risks, openQuestions, progress, keyDecisions, relevantEvidence, nextSteps.",
    "Every section is {text,evidenceIds,sourceHashes}; cite only supplied IDs/hashes. Preserve uncertainty and approval/gate status.",
    JSON.stringify({ originRun: args.originRun, sources: args.sources, messages: args.messages.map((message, index) => ({ id: message.id ?? `message-${index + 1}`, role: message.role, content: message.content })) }),
  ].join("\n");
}

export function parseContextDigest(args: {
  response: string;
  originRun: string;
  modelId: string;
  modelVersion?: string | null;
  priorDigestLink?: string | null;
  sources: ContextDigestSource[];
  deterministicallyExcludedToolPairs: string[];
}): ContextDigest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.response);
  } catch {
    throw new ContextCompressionError("Compression model did not return valid JSON.", "COMPRESSION_OUTPUT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextCompressionError("Compression model returned an invalid digest object.", "COMPRESSION_OUTPUT_INVALID");
  }
  const raw = parsed as Record<string, unknown>;
  const allowedEvidenceIds = new Set(args.sources.flatMap((source) => source.evidenceIds));
  const allowedSourceHashes = new Set(args.sources.map((source) => source.sourceHash));
  const rawSections = raw.sections && typeof raw.sections === "object" && !Array.isArray(raw.sections)
    ? raw.sections as Record<string, unknown>
    : raw;
  const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, normalizeSection(rawSections[key], allowedEvidenceIds, allowedSourceHashes)])) as ContextDigest["sections"];
  if (SECTION_KEYS.every((key) => !sections[key].text)) {
    throw new ContextCompressionError("Compression model returned an empty digest.", "COMPRESSION_OUTPUT_INVALID");
  }
  // Sources are deterministic provenance. The model may select citations, but cannot replace them.
  if (!sections.relevantEvidence.sourceHashes.length) {
    sections.relevantEvidence.sourceHashes = args.sources.map((source) => source.sourceHash);
    sections.relevantEvidence.evidenceIds = args.sources.flatMap((source) => source.evidenceIds);
  }
  return {
    schemaVersion: CONTEXT_DIGEST_SCHEMA_VERSION,
    digestId: randomUUID(),
    createdAt: new Date().toISOString(),
    originRun: args.originRun,
    model: { id: args.modelId, version: args.modelVersion ?? null },
    priorDigestLink: args.priorDigestLink ?? null,
    sources: args.sources,
    sections,
    deterministicallyExcludedToolPairs: args.deterministicallyExcludedToolPairs,
  };
}

export function renderContextDigest(digest: ContextDigest) {
  return `ContextDigest (auditable work product; raw source messages remain authoritative):\n${JSON.stringify(digest)}`;
}
