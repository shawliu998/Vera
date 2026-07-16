import { randomUUID } from "node:crypto";

import {
  DocumentStudioDraftPlanV21Schema,
  type DocumentStudioDraftPlanV21,
} from "../documentStudioTemplatesV21";
import type { DocumentStudioDraftTypeV20 } from "../documentStudioDraftMetadataV20";
import type { WorkspaceDatabaseAdapter } from "../migrations";

type TemplateRow = {
  id: string;
  project_id: string | null;
  title: string;
  description: string;
  document_type: string;
  content_markdown: string;
  draft_plan_json: string;
  updated_at: string;
};

export type DocumentStudioTemplateV21 = {
  templateId: string;
  scope: "builtin" | "project";
  title: string;
  description: string;
  documentType: DocumentStudioDraftTypeV20;
  content: string;
  plan: DocumentStudioDraftPlanV21;
  updatedAt: string;
};

export type DocumentStudioTemplateSummaryV21 = Omit<
  DocumentStudioTemplateV21,
  "content" | "plan"
> & { sectionCount: number };

function mapRow(row: TemplateRow): DocumentStudioTemplateV21 {
  const plan = DocumentStudioDraftPlanV21Schema.parse(
    JSON.parse(row.draft_plan_json),
  );
  if (plan.documentType !== row.document_type) {
    throw new Error("Template Draft Plan document type is inconsistent.");
  }
  return {
    templateId: row.id,
    scope: row.project_id === null ? "builtin" : "project",
    title: row.title,
    description: row.description,
    documentType: plan.documentType,
    content: row.content_markdown,
    plan,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceDocumentStudioTemplatesRepository {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly nextId: () => string = randomUUID,
  ) {}

  listVisible(projectId: string): DocumentStudioTemplateSummaryV21[] {
    const rows = this.database
      .prepare(
        `SELECT id, project_id, title, description, document_type,
                content_markdown, draft_plan_json, updated_at
           FROM document_studio_templates
          WHERE project_id IS NULL OR project_id = ?
          ORDER BY CASE WHEN project_id IS NULL THEN 0 ELSE 1 END,
                   title COLLATE NOCASE, id
          LIMIT 100`,
      )
      .all(projectId) as TemplateRow[];
    return rows.map((row) => {
      const template = mapRow(row);
      return {
        templateId: template.templateId,
        scope: template.scope,
        title: template.title,
        description: template.description,
        documentType: template.documentType,
        sectionCount: template.plan.sections.length,
        updatedAt: template.updatedAt,
      };
    });
  }

  getVisible(
    projectId: string,
    templateId: string,
  ): DocumentStudioTemplateV21 | null {
    const row = this.database
      .prepare(
        `SELECT id, project_id, title, description, document_type,
                content_markdown, draft_plan_json, updated_at
           FROM document_studio_templates
          WHERE id = ? AND (project_id IS NULL OR project_id = ?)`,
      )
      .get(templateId, projectId) as TemplateRow | undefined;
    return row ? mapRow(row) : null;
  }

  copyVisible(input: {
    projectId: string;
    templateId: string;
    title: string;
  }): DocumentStudioTemplateV21 | null {
    const id = this.nextId();
    const result = this.database
      .prepare(
        `INSERT INTO document_studio_templates (
           id, project_id, template_key, source_template_id, title, description,
           document_type, content_markdown, draft_plan_json
         )
         SELECT ?, ?, NULL, source.id, ?, source.description,
                source.document_type, source.content_markdown,
                source.draft_plan_json
           FROM document_studio_templates source
          WHERE source.id = ?
            AND (source.project_id IS NULL OR source.project_id = ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.templateId,
        input.projectId,
      ) as {
      changes: number;
    };
    return result.changes === 1 ? this.getVisible(input.projectId, id) : null;
  }

  updateLocal(input: {
    projectId: string;
    templateId: string;
    title: string;
    description: string;
    content: string;
    plan: DocumentStudioDraftPlanV21;
  }): DocumentStudioTemplateV21 | null {
    const result = this.database
      .prepare(
        `UPDATE document_studio_templates
            SET title = ?, description = ?, document_type = ?,
                content_markdown = ?, draft_plan_json = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND project_id = ?`,
      )
      .run(
        input.title,
        input.description,
        input.plan.documentType,
        input.content,
        JSON.stringify(input.plan),
        input.templateId,
        input.projectId,
      ) as { changes: number };
    return result.changes === 1
      ? this.getVisible(input.projectId, input.templateId)
      : null;
  }
}
