import type { WorkspaceDatabaseAdapter } from "./migrations/types";
import { WorkspaceApiError } from "./errors";

type DeletionScope =
  | Readonly<{ kind: "document"; documentId: string }>
  | Readonly<{ kind: "folder"; folderId: string }>;

export type ActiveAssistantDeletionJob = Readonly<{
  id: string;
  status: "queued" | "running";
}>;

type RelationSpec = Readonly<{
  table: string;
  columns: readonly string[];
  introducedIn: number;
}>;

type DeletionSchema = Readonly<{
  version: number;
  hasDocumentEdits: boolean;
  hasMessageSources: boolean;
  hasTabularReviewDocuments: boolean;
  hasTabularCells: boolean;
  hasAssistantAttachments: boolean;
  hasAssistantGenerationDocuments: boolean;
  hasTabularChatSources: boolean;
  workflowsHaveProjectId: boolean;
}>;

const RELATIONS = {
  documents: {
    table: "documents",
    columns: ["id", "folder_id"],
    introducedIn: 1,
  },
  documentVersions: {
    table: "document_versions",
    columns: ["id", "document_id"],
    introducedIn: 1,
  },
  projectSubfolders: {
    table: "project_subfolders",
    columns: ["id", "project_id", "parent_folder_id"],
    introducedIn: 1,
  },
  documentEdits: {
    table: "document_edits",
    columns: ["document_id", "version_id"],
    introducedIn: 1,
  },
  messageSources: {
    table: "message_sources",
    columns: ["document_id", "version_id"],
    introducedIn: 1,
  },
  tabularReviewDocuments: {
    table: "tabular_review_documents",
    columns: ["review_id", "document_id"],
    introducedIn: 2,
  },
  tabularCells: {
    table: "tabular_cells",
    columns: ["document_id"],
    introducedIn: 1,
  },
  assistantAttachments: {
    table: "chat_message_attachments",
    columns: ["document_id", "version_id"],
    introducedIn: 5,
  },
  assistantGenerationSnapshots: {
    table: "assistant_generation_snapshots",
    columns: ["job_id"],
    introducedIn: 5,
  },
  assistantGenerationDocuments: {
    table: "assistant_generation_documents",
    columns: ["job_id", "document_id", "version_id"],
    introducedIn: 5,
  },
  tabularReviewChatMessages: {
    table: "tabular_review_chat_messages",
    columns: ["id"],
    introducedIn: 1,
  },
  jobs: {
    table: "jobs",
    columns: ["id", "type", "status", "resource_type", "resource_id"],
    introducedIn: 1,
  },
  workflows: {
    table: "workflows",
    columns: ["id"],
    introducedIn: 1,
  },
  workflowRuns: {
    table: "workflow_runs",
    columns: ["id", "workflow_id", "project_id", "status"],
    introducedIn: 1,
  },
} as const satisfies Record<string, RelationSpec>;

function schemaFailure(message: string): never {
  throw new WorkspaceApiError(
    500,
    "INTERNAL_ERROR",
    `Workspace deletion policy schema is invalid: ${message}`,
  );
}

function tableExists(database: WorkspaceDatabaseAdapter, table: string) {
  return Boolean(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table),
  );
}

function tableColumns(database: WorkspaceDatabaseAdapter, table: string) {
  return new Set(
    database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name)),
  );
}

function migrationVersion(database: WorkspaceDatabaseAdapter) {
  if (!tableExists(database, "workspace_schema_migrations")) return 0;
  const columns = tableColumns(database, "workspace_schema_migrations");
  if (!columns.has("version")) {
    schemaFailure("workspace_schema_migrations.version is missing");
  }
  const row = database
    .prepare(
      "SELECT coalesce(max(version), 0) AS version FROM workspace_schema_migrations",
    )
    .get();
  const version = Number(row?.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    schemaFailure("the current migration version is invalid");
  }
  return version;
}

function inspectRelation(
  database: WorkspaceDatabaseAdapter,
  version: number,
  spec: RelationSpec,
) {
  const exists = tableExists(database, spec.table);
  if (!exists) {
    if (version >= spec.introducedIn) {
      schemaFailure(`${spec.table} is missing at migration v${version}`);
    }
    return false;
  }
  const columns = tableColumns(database, spec.table);
  for (const column of spec.columns) {
    if (!columns.has(column)) {
      schemaFailure(`${spec.table}.${column} is missing`);
    }
  }
  return true;
}

function inspectDeletionSchema(
  database: WorkspaceDatabaseAdapter,
): DeletionSchema {
  const version = migrationVersion(database);
  inspectRelation(database, version, RELATIONS.documents);
  inspectRelation(database, version, RELATIONS.documentVersions);
  inspectRelation(database, version, RELATIONS.projectSubfolders);
  const hasDocumentEdits = inspectRelation(
    database,
    version,
    RELATIONS.documentEdits,
  );
  const hasMessageSources = inspectRelation(
    database,
    version,
    RELATIONS.messageSources,
  );
  const hasTabularReviewDocuments = inspectRelation(
    database,
    version,
    RELATIONS.tabularReviewDocuments,
  );
  const hasTabularCells = inspectRelation(
    database,
    version,
    RELATIONS.tabularCells,
  );
  const hasAssistantAttachments = inspectRelation(
    database,
    version,
    RELATIONS.assistantAttachments,
  );
  const hasAssistantGenerationSnapshots = inspectRelation(
    database,
    version,
    RELATIONS.assistantGenerationSnapshots,
  );
  const hasAssistantGenerationDocuments = inspectRelation(
    database,
    version,
    RELATIONS.assistantGenerationDocuments,
  );
  if (hasAssistantGenerationSnapshots !== hasAssistantGenerationDocuments) {
    schemaFailure("assistant generation snapshot relations are incomplete");
  }
  inspectRelation(
    database,
    version,
    RELATIONS.tabularReviewChatMessages,
  );
  const tabularChatColumns = tableColumns(
    database,
    RELATIONS.tabularReviewChatMessages.table,
  );
  const hasTabularChatSources = tabularChatColumns.has("sources_json");
  if (version >= 7 && !hasTabularChatSources) {
    schemaFailure(
      `tabular_review_chat_messages.sources_json is missing at migration v${version}`,
    );
  }
  inspectRelation(database, version, RELATIONS.jobs);
  inspectRelation(database, version, RELATIONS.workflows);
  inspectRelation(database, version, RELATIONS.workflowRuns);
  const workflowColumns = tableColumns(database, "workflows");
  const workflowsHaveProjectId = workflowColumns.has("project_id");
  if (version >= 2 && !workflowsHaveProjectId) {
    schemaFailure(`workflows.project_id is missing at migration v${version}`);
  }
  return {
    version,
    hasDocumentEdits,
    hasMessageSources,
    hasTabularReviewDocuments,
    hasTabularCells,
    hasAssistantAttachments,
    hasAssistantGenerationDocuments,
    hasTabularChatSources,
    workflowsHaveProjectId,
  };
}

function targetCte(scope: DeletionScope) {
  if (scope.kind === "document") {
    return {
      sql: `WITH target_documents(id) AS (VALUES (?)),
                   target_versions(id) AS (
                     SELECT version.id
                       FROM document_versions version
                      WHERE version.document_id IN (SELECT id FROM target_documents)
                   )`,
      id: scope.documentId,
    };
  }
  return {
    sql: `WITH RECURSIVE folder_subtree(id) AS (
            SELECT id FROM project_subfolders WHERE id = ?
            UNION ALL
            SELECT child.id
              FROM project_subfolders child
              JOIN folder_subtree parent ON child.parent_folder_id = parent.id
          ),
          target_documents(id) AS (
            SELECT document.id
              FROM documents document
             WHERE document.folder_id IN (SELECT id FROM folder_subtree)
          ),
          target_versions(id) AS (
            SELECT version.id
              FROM document_versions version
             WHERE version.document_id IN (SELECT id FROM target_documents)
          )`,
    id: scope.folderId,
  };
}

function directDocumentOrVersionReference(table: string, alias: string) {
  return `EXISTS (
    SELECT 1 FROM ${table} ${alias}
     WHERE ${alias}.document_id IN (SELECT id FROM target_documents)
        OR ${alias}.version_id IN (SELECT id FROM target_versions)
  )`;
}

/**
 * The one authoritative, exact deletion-history policy for both a single
 * document and a folder subtree. It intentionally does not inspect job
 * payloads or use substring matching.
 */
export function assertNoDurableDocumentHistory(
  database: WorkspaceDatabaseAdapter,
  scope: DeletionScope,
) {
  const schema = inspectDeletionSchema(database);
  const target = targetCte(scope);
  const references: string[] = [];

  if (schema.hasMessageSources) {
    references.push(
      `SELECT 'message_source' AS reference_kind
         WHERE ${directDocumentOrVersionReference("message_sources", "source")}`,
    );
  }
  if (schema.hasAssistantAttachments) {
    references.push(
      `SELECT 'chat_attachment' AS reference_kind
         WHERE ${directDocumentOrVersionReference("chat_message_attachments", "attachment")}`,
    );
  }
  if (schema.hasAssistantGenerationDocuments) {
    references.push(
      `SELECT 'assistant_generation_document' AS reference_kind
         WHERE ${directDocumentOrVersionReference("assistant_generation_documents", "snapshot_document")}`,
    );
  }
  if (schema.hasTabularReviewDocuments) {
    references.push(
      `SELECT 'tabular_review_document' AS reference_kind
         WHERE EXISTS (
           SELECT 1 FROM tabular_review_documents review_document
            WHERE review_document.document_id IN (SELECT id FROM target_documents)
         )`,
    );
  }
  if (schema.hasTabularCells) {
    references.push(
      `SELECT 'tabular_cell' AS reference_kind
         WHERE EXISTS (
           SELECT 1 FROM tabular_cells cell
            WHERE cell.document_id IN (SELECT id FROM target_documents)
         )`,
    );
  }
  if (schema.hasTabularChatSources) {
    references.push(
      `SELECT 'tabular_chat_source' AS reference_kind
         WHERE EXISTS (
           SELECT 1
             FROM tabular_review_chat_messages message,
                  json_each(message.sources_json) source
            WHERE source.type = 'object'
              AND (
                (
                  json_type(source.value, '$.documentId') = 'text' AND
                  json_extract(source.value, '$.documentId') IN
                    (SELECT id FROM target_documents)
                ) OR (
                  json_type(source.value, '$.versionId') = 'text' AND
                  json_extract(source.value, '$.versionId') IN
                    (SELECT id FROM target_versions)
                )
              )
         )`,
    );
  }
  if (schema.hasDocumentEdits) {
    references.push(
      `SELECT 'document_edit' AS reference_kind
         WHERE ${directDocumentOrVersionReference("document_edits", "edit_record")}`,
    );
  }

  const row = references.length
    ? database
        .prepare(
          `${target.sql}
           SELECT reference_kind FROM (
             ${references.join("\nUNION ALL\n")}
           ) LIMIT 1`,
        )
        .get(target.id)
    : undefined;
  if (!row) return;

  const reason =
    scope.kind === "folder"
      ? "folder_has_durable_history"
      : "document_has_durable_history";
  throw new WorkspaceApiError(
    409,
    "CONFLICT",
    scope.kind === "folder"
      ? "Folder deletion would remove documents used by durable history."
      : "Document deletion would remove durable history.",
    [{ path: "reason", message: reason }],
  );
}

/** v1-v4 callers retain their conservative legacy assistant fence. */
export function hasExactAssistantDocumentBindings(
  database: WorkspaceDatabaseAdapter,
) {
  return inspectDeletionSchema(database).hasAssistantGenerationDocuments;
}

/** Exact v5 snapshot binding used by the folder job fence (never payload JSON). */
export function listActiveFolderAssistantJobs(
  database: WorkspaceDatabaseAdapter,
  folderId: string,
): ActiveAssistantDeletionJob[] {
  const schema = inspectDeletionSchema(database);
  if (!schema.hasAssistantGenerationDocuments) return [];
  const rows = database
    .prepare(
      `WITH RECURSIVE folder_subtree(id) AS (
         SELECT id FROM project_subfolders WHERE id = ?
         UNION ALL
         SELECT child.id
           FROM project_subfolders child
           JOIN folder_subtree parent ON child.parent_folder_id = parent.id
       ),
       target_documents(id) AS (
         SELECT document.id FROM documents document
          WHERE document.folder_id IN (SELECT id FROM folder_subtree)
       )
       SELECT DISTINCT job.id, job.status
         FROM assistant_generation_documents snapshot_document
         JOIN assistant_generation_snapshots snapshot
           ON snapshot.job_id = snapshot_document.job_id
         JOIN jobs job ON job.id = snapshot.job_id
        WHERE snapshot_document.document_id IN (SELECT id FROM target_documents)
          AND job.type = 'assistant_generate'
          AND job.status IN ('queued', 'running')
        ORDER BY job.status, job.id`,
    )
    .all(folderId);
  return rows.map((row) => {
    const status = String(row.status);
    if (status !== "queued" && status !== "running") {
      schemaFailure("an active assistant job has an invalid status");
    }
    return { id: String(row.id), status };
  });
}

/**
 * Workflow inputs are not normalized yet, so exact document membership is not
 * queryable. Until a binding table exists, any active run owned by the folder's
 * project conservatively fences folder deletion. Job payloads are never read.
 */
function assertNoActiveProjectWorkflow(
  database: WorkspaceDatabaseAdapter,
  target:
    | Readonly<{ kind: "folder"; id: string }>
    | Readonly<{ kind: "document"; id: string }>,
) {
  const schema = inspectDeletionSchema(database);
  const workflowProjectPredicate = schema.workflowsHaveProjectId
    ? "OR workflow.project_id = target.project_id"
    : "";
  const targetProjectSql =
    target.kind === "folder"
      ? "SELECT project_id FROM project_subfolders WHERE id = ?"
      : "SELECT project_id FROM documents WHERE id = ? AND project_id IS NOT NULL";
  const row = database
    .prepare(
      `WITH target(project_id) AS (
         ${targetProjectSql}
       )
       SELECT run.id
         FROM workflow_runs run
         LEFT JOIN workflows workflow ON workflow.id = run.workflow_id
         JOIN target
        WHERE run.status IN ('queued', 'waiting', 'running')
          AND (
            run.project_id = target.project_id
            ${workflowProjectPredicate}
          )
        LIMIT 1`,
    )
    .get(target.id);
  if (!row) return;
  const isFolder = target.kind === "folder";
  throw new WorkspaceApiError(
    409,
    "CONFLICT",
    `${isFolder ? "Folder" : "Document"} deletion is blocked while its project has active workflow runs.`,
    [
      {
        path: "reason",
        message: isFolder
          ? "folder_has_active_workflow"
          : "document_has_active_workflow",
      },
    ],
  );
}

export function assertNoActiveProjectWorkflowForFolder(
  database: WorkspaceDatabaseAdapter,
  folderId: string,
) {
  assertNoActiveProjectWorkflow(database, { kind: "folder", id: folderId });
}

export function assertNoActiveProjectWorkflowForDocument(
  database: WorkspaceDatabaseAdapter,
  documentId: string,
) {
  assertNoActiveProjectWorkflow(database, {
    kind: "document",
    id: documentId,
  });
}
