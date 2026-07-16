import { z } from "zod";

import { WorkspaceApiError } from "../../lib/workspace/errors";
import type { WorkspaceDatabaseAdapter } from "../../lib/workspace/migrations";
import { WorkspaceIdSchema } from "../../lib/workspace/workspacePersistencePrimitivesV1";
import {
  MatterListRequestSchema,
  MatterProfileSchema,
  MatterProjectProjectionSchema,
  MatterViewPageSchema,
  MatterViewSchema,
  matterProfilePresentation,
  type MatterListRequest,
  type MatterProfile,
  type MatterView,
  type MatterViewPage,
} from "./contracts";

type Row = Record<string, unknown>;

const PROJECT_MATTER_COLUMNS = `
  p.id AS project_id,
  p.name AS project_name,
  p.description AS project_description,
  p.cm_number AS project_cm_number,
  p.practice AS project_practice,
  p.status AS project_status,
  p.default_model_profile_id AS project_default_model_profile_id,
  p.created_at AS project_created_at,
  p.updated_at AS project_updated_at,
  p.archived_at AS project_archived_at,
  coalesce(dc.total, 0) AS project_document_count,
  coalesce(cc.total, 0) AS project_chat_count,
  coalesce(trc.total, 0) AS project_tabular_review_count,
  coalesce(wc.total, 0) AS project_workflow_count,
  mp.project_id AS profile_project_id,
  mp.workspace_type AS profile_workspace_type,
  mp.client_name AS profile_client_name,
  mp.jurisdiction AS profile_jurisdiction,
  mp.represented_role AS profile_represented_role,
  mp.objective AS profile_objective,
  mp.created_at AS profile_created_at,
  mp.updated_at AS profile_updated_at
`;

function projectionQuery(selectedProjectsSql: string): string {
  return `
    WITH selected_projects AS (
      ${selectedProjectsSql}
    ),
    document_counts AS (
      SELECT d.project_id, count(*) AS total
        FROM documents d
        JOIN selected_projects selected ON selected.id = d.project_id
       WHERE d.deleted_at IS NULL
       GROUP BY d.project_id
    ),
    chat_counts AS (
      SELECT c.project_id, count(*) AS total
        FROM chats c
        JOIN selected_projects selected ON selected.id = c.project_id
       GROUP BY c.project_id
    ),
    tabular_review_counts AS (
      SELECT review.project_id, count(*) AS total
        FROM tabular_reviews review
        JOIN selected_projects selected ON selected.id = review.project_id
       GROUP BY review.project_id
    ),
    workflow_counts AS (
      SELECT workflow.project_id, count(*) AS total
        FROM workflows workflow
        JOIN selected_projects selected ON selected.id = workflow.project_id
       GROUP BY workflow.project_id
    )
    SELECT ${PROJECT_MATTER_COLUMNS}
      FROM selected_projects p
      LEFT JOIN document_counts dc ON dc.project_id = p.id
      LEFT JOIN chat_counts cc ON cc.project_id = p.id
      LEFT JOIN tabular_review_counts trc ON trc.project_id = p.id
      LEFT JOIN workflow_counts wc ON wc.project_id = p.id
      LEFT JOIN matter_profiles mp ON mp.project_id = p.id
     ORDER BY p.updated_at DESC, p.id DESC
  `;
}

const CursorSchema = z
  .object({
    updatedAt: z.string().datetime({ offset: true }),
    id: WorkspaceIdSchema,
  })
  .strict();

function validationError(message: string): never {
  throw new WorkspaceApiError(400, "VALIDATION_ERROR", message);
}

function internal(message: string): never {
  throw new WorkspaceApiError(500, "INTERNAL_ERROR", message);
}

function mapMatterProfile(row: Row): MatterProfile | null {
  if (row.profile_project_id == null) return null;
  try {
    return MatterProfileSchema.parse({
      projectId: row.profile_project_id,
      workspaceType: row.profile_workspace_type,
      clientName: row.profile_client_name,
      jurisdiction: row.profile_jurisdiction,
      representedRole: row.profile_represented_role,
      objective: row.profile_objective,
      createdAt: row.profile_created_at,
      updatedAt: row.profile_updated_at,
    });
  } catch {
    internal("Persisted Matter Profile is invalid.");
  }
}

function mapMatterView(row: Row): MatterView {
  try {
    const profile = mapMatterProfile(row);
    return MatterViewSchema.parse({
      project: {
        id: row.project_id,
        name: row.project_name,
        description: row.project_description,
        cmNumber: row.project_cm_number,
        practice: row.project_practice,
        status: row.project_status,
        defaultModelProfileId: row.project_default_model_profile_id,
        createdAt: row.project_created_at,
        updatedAt: row.project_updated_at,
        archivedAt: row.project_archived_at,
        documentCount: Number(row.project_document_count),
        chatCount: Number(row.project_chat_count),
        tabularReviewCount: Number(row.project_tabular_review_count),
        workflowCount: Number(row.project_workflow_count),
      },
      profile,
      ...matterProfilePresentation(
        MatterProjectProjectionSchema.shape.status.parse(row.project_status),
        profile,
      ),
    });
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    internal("Persisted Matter projection is invalid.");
  }
}

function encodeCursor(view: MatterView): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: view.project.updatedAt,
      id: view.project.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | null | undefined) {
  if (value == null) return null;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    validationError("Matter pagination cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > 1_024) {
      validationError("Matter pagination cursor is invalid.");
    }
    return CursorSchema.parse(JSON.parse(decoded) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    validationError("Matter pagination cursor is invalid.");
  }
}

export interface MatterOverviewReadPort {
  readonly database: WorkspaceDatabaseAdapter;
  list(input?: MatterListRequest): MatterViewPage;
  get(projectId: string): MatterView | null;
  require(projectId: string): MatterView;
}

/** Read-only owner for Matter list/detail projection and aggregate counts. */
export class MatterOverviewRepository implements MatterOverviewReadPort {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private safe<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Matter overview data operation failed.",
      );
    }
  }

  list(input: MatterListRequest = {}): MatterViewPage {
    return this.safe(() => {
      const request = MatterListRequestSchema.parse(input);
      const cursor = decodeCursor(request.cursor);
      const limit = request.limit ?? 50;
      const rows = this.database
        .prepare(
          projectionQuery(`
            SELECT p.*
              FROM projects p
             WHERE p.status = ?
               ${
                 cursor
                   ? "AND (p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))"
                   : ""
               }
             ORDER BY p.updated_at DESC, p.id DESC
             LIMIT ?
          `),
        )
        .all(
          request.status ?? "active",
          ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
          limit + 1,
        );
      const items = rows.slice(0, limit).map(mapMatterView);
      const last = items.at(-1);
      return MatterViewPageSchema.parse({
        items,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last) : null,
      });
    });
  }

  get(projectId: string): MatterView | null {
    return this.safe(() => {
      const parsedProjectId = WorkspaceIdSchema.safeParse(projectId);
      if (!parsedProjectId.success) {
        validationError("Project id is invalid.");
      }
      const row = this.database
        .prepare(
          projectionQuery(`
            SELECT p.*
              FROM projects p
             WHERE p.id = ?
             LIMIT 1
          `),
        )
        .get(parsedProjectId.data);
      return row ? mapMatterView(row) : null;
    });
  }

  require(projectId: string): MatterView {
    return this.safe(() => {
      const view = this.get(projectId);
      if (!view) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
      }
      return view;
    });
  }
}
