import type { ColumnConfig, Document, TabularCell } from "../shared/types";

export type TabularCellUpdate = {
  documentId: string;
  columnIndex: number;
  content: TabularCell["content"];
  status: TabularCell["status"];
  issueCode?: string;
};

const CELL_STATUSES = new Set(["pending", "generating", "done", "error"]);
const CELL_FLAGS = new Set(["green", "grey", "yellow", "red"]);

function parseCellContent(value: unknown): TabularCell["content"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = value as Record<string, unknown>;
  if (typeof content.summary !== "string") return null;
  return {
    summary: content.summary,
    flag:
      typeof content.flag === "string" && CELL_FLAGS.has(content.flag)
        ? (content.flag as "green" | "grey" | "yellow" | "red")
        : undefined,
    reasoning:
      typeof content.reasoning === "string" ? content.reasoning : undefined,
  };
}

export function prepareTabularCellsForGeneration(input: {
  cells: TabularCell[];
  documents: Document[];
  columns: ColumnConfig[];
  reviewId: string;
  createdAt?: string;
}) {
  const existingByKey = new Map(
    input.cells.map((cell) => [
      `${cell.document_id}:${cell.column_index}`,
      cell,
    ]),
  );
  const createdAt = input.createdAt ?? new Date().toISOString();
  return input.documents.flatMap((document) =>
    input.columns.map((column) => {
      const existing = existingByKey.get(`${document.id}:${column.index}`);
      if (existing?.status === "done" && existing.content) return existing;
      return existing
        ? {
            ...existing,
            status: "generating" as const,
            content: null,
          }
        : {
            id: `${document.id}-${column.index}`,
            review_id: input.reviewId,
            document_id: document.id,
            column_index: column.index,
            content: null,
            status: "generating" as const,
            created_at: createdAt,
          };
    }),
  );
}

function parseCellUpdate(value: unknown): TabularCellUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    event.type !== "cell_update" ||
    typeof event.document_id !== "string" ||
    typeof event.column_index !== "number" ||
    !Number.isInteger(event.column_index) ||
    typeof event.status !== "string" ||
    !CELL_STATUSES.has(event.status)
  ) {
    return null;
  }
  const content = parseCellContent(event.content);
  if (event.status === "done" && !content) return null;
  return {
    documentId: event.document_id,
    columnIndex: event.column_index,
    content,
    status: event.status as TabularCell["status"],
    issueCode:
      typeof event.issue_code === "string" ? event.issue_code : undefined,
  };
}

export async function readTabularGenerationStream(
  response: Response,
  onUpdate: (update: TabularCellUpdate) => void,
) {
  if (!response.body) throw new Error("Tabular generation returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError: string | null = null;

  const processLine = (line: string) => {
    if (!line.startsWith("data:")) return false;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return true;
    try {
      const event = JSON.parse(payload) as unknown;
      const update = parseCellUpdate(event);
      if (update) onUpdate(update);
      if (
        event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as Record<string, unknown>).type === "error"
      ) {
        const message = (event as Record<string, unknown>).message;
        streamError =
          typeof message === "string" && message.trim()
            ? message.trim()
            : "Tabular generation stream failed";
      }
    } catch {
      // Ignore non-JSON SSE metadata without discarding later events.
    }
    return false;
  };

  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (processLine(line)) {
        finished = true;
        break;
      }
    }
  }
  buffer += decoder.decode();
  if (!finished && buffer) processLine(buffer);
  if (streamError) throw new Error(streamError);
}
