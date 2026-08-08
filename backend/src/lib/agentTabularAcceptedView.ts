import { createHash } from "node:crypto";

import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export type AgentTabularAcceptedViewBuildIssueCode =
  | "cell_scope_exceeded"
  | "invalid_layout";

/**
 * A server-owned classification for materialization failures. Callers must
 * route on this code rather than interpreting an Error message.
 */
export class AgentTabularAcceptedViewBuildError extends Error {
  constructor(
    readonly code: AgentTabularAcceptedViewBuildIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentTabularAcceptedViewBuildError";
  }
}

export function isAgentTabularAcceptedViewBuildError(
  value: unknown,
): value is AgentTabularAcceptedViewBuildError {
  return value instanceof AgentTabularAcceptedViewBuildError;
}

export const AGENT_TABULAR_ACCEPTED_VIEW_KIND =
  "agent_tabular_accepted_view_v1" as const;

export type AgentTabularAcceptedViewCellInput = {
  id: string;
  document_id: string;
  row_id: string | null;
  column_index: number;
  status: string | null;
  content: string | null;
  citations: unknown;
  review_status?: string | null;
  reviewed_at?: string | null;
  review_revision?: number | null;
};

export type AgentTabularAcceptedViewInput = {
  review: {
    id: string;
    title: string | null;
    practice: string | null;
    workflow_id: string | null;
    row_protocol: string | null;
    document_ids: unknown;
    columns_config: unknown;
  };
  input_digest: string;
  document_ids: string[];
  column_indexes: number[];
  cells: AgentTabularAcceptedViewCellInput[];
};

const boundedText = z.string().max(50_000);
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    boundedText,
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const agentTabularAcceptedViewSchema = z
  .object({
    kind: z.literal(AGENT_TABULAR_ACCEPTED_VIEW_KIND),
    review_id: z.string().uuid(),
    row_protocol: z.literal("document_rows"),
    input_digest: digestSchema,
    review: z
      .object({
        title: z.string().max(500).nullable(),
        practice: z.string().max(120).nullable(),
        workflow_id: z.string().max(200).nullable(),
        document_ids: z.array(z.string().uuid()).min(1).max(500),
        columns_config: z.array(jsonValueSchema).min(1).max(200),
      })
      .strict(),
    cells: z
      .array(
        z
          .object({
            cell_id: z.string().uuid(),
            document_id: z.string().uuid(),
            row_id: z.string().uuid().nullable(),
            column_index: z.number().int().nonnegative(),
            status: z.enum(["pending", "done"]).nullable(),
            content: boundedText.nullable(),
            citations: jsonValueSchema,
            review_status: z
              .enum(["verified", "unresolved", "needs_correction"])
              .nullable(),
            reviewed_at: z.string().datetime().nullable(),
            review_revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type AgentTabularAcceptedView = z.infer<
  typeof agentTabularAcceptedViewSchema
>;

export type AgentTabularAcceptedViewMaterialization = {
  accepted_view: AgentTabularAcceptedView;
  accepted_view_text: string;
  accepted_view_sha256: string;
};

/** JSON encoding with sorted object keys; arrays preserve their fixed order. */
export function canonicalAgentArtifactJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalAgentArtifactJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalAgentArtifactJson(item)}`,
    )
    .join(",")}}`;
}

export function sha256AgentArtifact(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(canonicalAgentArtifactJson(value))
    .digest("hex")}`;
}

function requireDocumentRows(input: AgentTabularAcceptedViewInput) {
  if (input.review.row_protocol !== "document_rows") {
    throw new AgentTabularAcceptedViewBuildError(
      "invalid_layout",
      "A verified Tabular accepted view requires document_rows",
    );
  }
  if (
    !input.document_ids.length ||
    !input.column_indexes.length ||
    new Set(input.document_ids).size !== input.document_ids.length ||
    new Set(input.column_indexes).size !== input.column_indexes.length
  ) {
    throw new AgentTabularAcceptedViewBuildError(
      "invalid_layout",
      "A Tabular accepted view requires one fixed layout",
    );
  }
}

/**
 * Builds the complete, ordered accepted view from server-loaded Review rows.
 * This deliberately includes every cell and never uses a model projection.
 */
export function buildAgentTabularAcceptedView(
  input: AgentTabularAcceptedViewInput,
): AgentTabularAcceptedViewMaterialization {
  requireDocumentRows(input);
  if (input.document_ids.length * input.column_indexes.length > 500) {
    throw new AgentTabularAcceptedViewBuildError(
      "cell_scope_exceeded",
      "A verified Tabular accepted view may contain at most 500 fixed cells",
    );
  }
  const documentPosition = new Map(
    input.document_ids.map((documentId, index) => [documentId, index]),
  );
  const columnPosition = new Map(
    input.column_indexes.map((columnIndex, index) => [columnIndex, index]),
  );
  const expected = new Set(
    input.document_ids.flatMap((documentId) =>
      input.column_indexes.map((columnIndex) => `${documentId}:${columnIndex}`),
    ),
  );
  const cellsByCoordinate = new Map<string, AgentTabularAcceptedViewCellInput>();
  for (const cell of input.cells) {
    const coordinate = `${cell.document_id}:${cell.column_index}`;
    if (!expected.has(coordinate) || cellsByCoordinate.has(coordinate)) {
      throw new AgentTabularAcceptedViewBuildError(
        "invalid_layout",
        "A Tabular accepted view has an invalid fixed cell coordinate",
      );
    }
    cellsByCoordinate.set(coordinate, cell);
  }
  if (cellsByCoordinate.size !== expected.size) {
    throw new AgentTabularAcceptedViewBuildError(
      "invalid_layout",
      "A Tabular accepted view is incomplete",
    );
  }
  const cells = [...cellsByCoordinate.values()]
    .sort((left, right) => {
      const documentOrder =
        documentPosition.get(left.document_id)! -
        documentPosition.get(right.document_id)!;
      if (documentOrder) return documentOrder;
      return (
        columnPosition.get(left.column_index)! -
        columnPosition.get(right.column_index)!
      );
    })
    .map((cell) => ({
      cell_id: cell.id,
      document_id: cell.document_id,
      row_id: cell.row_id,
      column_index: cell.column_index,
      status: cell.status,
      content: cell.content,
      citations: cell.citations ?? null,
      review_status: cell.review_status ?? null,
      reviewed_at: cell.reviewed_at ?? null,
      review_revision: cell.review_revision ?? 0,
    }));
  const parsed = agentTabularAcceptedViewSchema.safeParse({
    kind: AGENT_TABULAR_ACCEPTED_VIEW_KIND,
    review_id: input.review.id,
    row_protocol: "document_rows",
    input_digest: input.input_digest,
    review: {
      title: input.review.title,
      practice: input.review.practice,
      workflow_id: input.review.workflow_id,
      document_ids: input.document_ids,
      columns_config: input.review.columns_config,
    },
    cells,
  });
  if (!parsed.success) {
    throw new AgentTabularAcceptedViewBuildError(
      "invalid_layout",
      "A Tabular accepted view does not match its fixed schema",
    );
  }
  const accepted_view = parsed.data;
  const accepted_view_text = canonicalAgentArtifactJson(accepted_view);
  const accepted_view_sha256 = sha256AgentArtifact(accepted_view);
  return {
    accepted_view,
    accepted_view_text,
    accepted_view_sha256,
  };
}
