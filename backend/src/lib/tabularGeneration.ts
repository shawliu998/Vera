export type TabularGenerationColumn = {
  index: number;
  name: string;
  prompt: string;
  format?: string;
  tags?: string[];
};

export type TabularCellResult = {
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
};

export type TabularGenerationLine =
  | { kind: "result"; columnIndex: number; result: TabularCellResult }
  | { kind: "ignorable" }
  | { kind: "malformed" };

const FLAGS = ["green", "grey", "yellow", "red"] as const;

export function parseTabularGenerationLine(
  line: string,
  expectedColumnIndexes: ReadonlySet<number>,
): TabularGenerationLine {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "```" || trimmed === "```json") {
    return { kind: "ignorable" };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const columnIndex = parsed.column_index;
    if (
      typeof columnIndex !== "number" ||
      !Number.isInteger(columnIndex) ||
      !expectedColumnIndexes.has(columnIndex)
    ) {
      return { kind: "malformed" };
    }
    return {
      kind: "result",
      columnIndex,
      result: {
        summary: String(parsed.summary ?? "").trim() || "Not addressed",
        flag: FLAGS.includes(parsed.flag as (typeof FLAGS)[number])
          ? (parsed.flag as TabularCellResult["flag"])
          : "grey",
        reasoning: String(parsed.reasoning ?? ""),
      },
    };
  } catch {
    return { kind: "malformed" };
  }
}

export async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<void>,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      "Tabular generation concurrency must be a positive integer",
    );
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await operation(values[index], index);
      }
    }),
  );
}

export function planTabularRecovery(
  columns: readonly TabularGenerationColumn[],
  completedColumnIndexes: ReadonlySet<number>,
  input: { streamFailed: boolean; automaticRecoveryLimit: number },
) {
  const missing = columns.filter(
    (column) => !completedColumnIndexes.has(column.index),
  );
  const recover = input.streamFailed
    ? []
    : missing.slice(0, Math.max(0, input.automaticRecoveryLimit));
  const recoverIndexes = new Set(recover.map((column) => column.index));
  return {
    recover,
    pending: missing.filter((column) => !recoverIndexes.has(column.index)),
  };
}
