import { createHash } from "node:crypto";

export class LitigationAgentPartitionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "PARTITION_ITEM_TOO_LARGE"
      | "PARTITION_LIMIT_EXCEEDED"
      | "PARTITION_HAS_NO_SOURCES",
  ) {
    super(message);
    this.name = "LitigationAgentPartitionError";
  }
}

type JsonRecord = Record<string, any>;

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sourceIdsIn(value: unknown, allowed: Set<string>) {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      if (allowed.has(item)) found.add(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return found;
}

function focusTokens(value: string) {
  const normalized = value.toLocaleLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjk = [...normalized].filter((character) =>
    /[\p{Script=Han}]/u.test(character),
  );
  const cjkBigrams = cjk
    .slice(0, -1)
    .map((character, index) => `${character}${cjk[index + 1]}`);
  return [...new Set([...latin, ...cjk, ...cjkBigrams])].filter(Boolean);
}

function relevanceScore(value: unknown, tokens: string[]) {
  const text = JSON.stringify(value).toLocaleLowerCase();
  return tokens.reduce((score, token) => {
    let offset = 0;
    let matches = 0;
    while (matches < 20) {
      const index = text.indexOf(token, offset);
      if (index < 0) break;
      matches += 1;
      offset = index + token.length;
    }
    return score + matches;
  }, 0);
}

export function buildLitigationAgentPartitions(
  snapshot: JsonRecord,
  maximumBytes: number,
  maximumPartitions = 24,
  options: { focus?: string } = {},
) {
  const focus = String(options.focus ?? "")
    .trim()
    .slice(0, 500);
  const tokens = focusTokens(focus);
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const sourceEntries = sources
    .filter((item: unknown): item is JsonRecord =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
    )
    .map((source: JsonRecord): [string, JsonRecord] => [
      String(source.id ?? ""),
      source,
    ])
    .filter(([id]) => Boolean(id));
  const sourceById = new Map<string, JsonRecord>(sourceEntries);
  const allowed = new Set(sourceById.keys());
  if (allowed.size === 0) {
    throw new LitigationAgentPartitionError(
      "Litigation snapshot has no verified sources.",
      "PARTITION_HAS_NO_SOURCES",
    );
  }
  const factSources = Array.isArray(snapshot.factSources)
    ? snapshot.factSources
    : [];
  const units = [
    ...(Array.isArray(snapshot.facts) ? snapshot.facts : []).map(
      (fact: JsonRecord) => ({
        kind: "fact",
        id: String(fact.id ?? ""),
        value: {
          fact,
          sourceRelations: factSources.filter(
            (item: JsonRecord) => item.fact_id === fact.id,
          ),
        },
      }),
    ),
    ...(Array.isArray(snapshot.positions) ? snapshot.positions : []).map(
      (value: JsonRecord) => ({
        kind: "position",
        id: String(value.id ?? ""),
        value,
      }),
    ),
    ...(Array.isArray(snapshot.events) ? snapshot.events : []).map(
      (value: JsonRecord) => ({
        kind: "event",
        id: String(value.id ?? ""),
        value,
      }),
    ),
    ...(Array.isArray(snapshot.deadlines) ? snapshot.deadlines : []).map(
      (value: JsonRecord) => ({
        kind: "deadline",
        id: String(value.id ?? ""),
        value,
      }),
    ),
    ...(Array.isArray(snapshot.reviewedRetrievalExcerpts)
      ? snapshot.reviewedRetrievalExcerpts
      : []
    ).map((value: JsonRecord) => ({
      kind: "reviewed_retrieval_excerpt",
      id: String(value.id ?? ""),
      value,
    })),
  ].map((unit, originalIndex) => ({
    ...unit,
    originalIndex,
    relevanceScore: relevanceScore(unit.value, tokens),
    sourceIds: sourceIdsIn(unit.value, allowed),
  }));
  const excludedUnboundUnits = units.filter(
    (unit) => unit.sourceIds.size === 0,
  ).length;
  const groundedUnits = units
    .filter((unit) => unit.sourceIds.size > 0)
    .sort((left, right) =>
      tokens.length
        ? right.relevanceScore - left.relevanceScore ||
          left.originalIndex - right.originalIndex
        : left.originalIndex - right.originalIndex,
    );
  if (groundedUnits.length === 0) {
    throw new LitigationAgentPartitionError(
      "No litigation snapshot item is bound to a verified source.",
      "PARTITION_HAS_NO_SOURCES",
    );
  }

  const base = {
    schemaVersion: "aletheia-litigation-agent-partition-v1",
    matterId: snapshot.matterId,
    parentSnapshotHash: snapshot.snapshotHash,
    statePolicy: snapshot.statePolicy,
    exclusions: snapshot.exclusions,
    retrievalInputBinding: snapshot.retrievalInputBinding ?? null,
    ordering: {
      strategy: tokens.length
        ? "deterministic_lexical_all_units"
        : "source_order",
      focus: focus || null,
      tokens,
      omissionPolicy: "none",
    },
  };
  const groups: (typeof groundedUnits)[] = [];
  let current: typeof groundedUnits = [];
  const materialize = (items: typeof groundedUnits) => {
    const ids = new Set(items.flatMap((item) => [...item.sourceIds]));
    return {
      ...base,
      items: items.map(({ sourceIds: _sourceIds, ...item }) => item),
      sources: [...ids]
        .map((id) => sourceById.get(id))
        .filter((source): source is JsonRecord => Boolean(source)),
    };
  };
  for (const unit of groundedUnits) {
    if (bytes(materialize([unit])) > maximumBytes) {
      throw new LitigationAgentPartitionError(
        `Litigation ${unit.kind} ${unit.id || "(unknown)"} exceeds the partition budget.`,
        "PARTITION_ITEM_TOO_LARGE",
      );
    }
    const candidate = [...current, unit];
    if (current.length > 0 && bytes(materialize(candidate)) > maximumBytes) {
      groups.push(current);
      current = [unit];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);
  if (groups.length > maximumPartitions) {
    throw new LitigationAgentPartitionError(
      `Litigation snapshot requires ${groups.length} partitions; limit is ${maximumPartitions}.`,
      "PARTITION_LIMIT_EXCEEDED",
    );
  }
  return {
    excludedUnboundUnits,
    ordering: base.ordering,
    partitions: groups.map((group, index) => {
      const content = {
        ...materialize(group),
        partition: index + 1,
        partitionCount: groups.length,
      };
      return {
        content,
        bytes: bytes(content),
        hash: `sha256:${createHash("sha256")
          .update(JSON.stringify(content))
          .digest("hex")}`,
      };
    }),
  };
}

export function planLitigationAgentExecution(
  snapshot: JsonRecord,
  contextWindowTokens: number,
  options: { focus?: string; maximumPartitions?: number } = {},
) {
  const serializedSnapshot = JSON.stringify(snapshot);
  const snapshotBytes = Buffer.byteLength(serializedSnapshot, "utf8");
  const partitionBudgetBytes = Math.min(
    180_000,
    Math.max(16_000, (contextWindowTokens - 4_096) * 2),
  );
  const partitioned =
    snapshotBytes > partitionBudgetBytes
      ? buildLitigationAgentPartitions(
          snapshot,
          partitionBudgetBytes,
          options.maximumPartitions ?? 24,
          { focus: options.focus },
        )
      : null;
  return {
    serializedSnapshot,
    snapshotBytes,
    partitionBudgetBytes,
    partitioned,
    executionMode: partitioned
      ? ("source_partitioned" as const)
      : ("single_snapshot" as const),
  };
}
