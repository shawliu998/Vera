import { z } from "zod";

import { WorkspaceApiError } from "../errors";
import {
  DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21,
  DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21,
  DocumentStudioDraftPlanV21Schema,
} from "../documentStudioTemplatesV21";
import {
  WorkspaceDocumentStudioTemplatesRepository,
  type DocumentStudioTemplateV21,
} from "../repositories/documentStudioTemplates";

const Id = z.string().uuid();
const Title = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= 240)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Description = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= 500)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Content = z
  .string()
  .min(1)
  .max(DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <=
      DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21,
  )
  .refine(
    (value) =>
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
  );

function safeTemplate(template: DocumentStudioTemplateV21) {
  if (
    template.content.length > DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21 ||
    Buffer.byteLength(template.content, "utf8") >
      DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Document template content failed its storage boundary.",
    );
  }
  DocumentStudioDraftPlanV21Schema.parse(template.plan);
  return template;
}

function notFound(): never {
  throw new WorkspaceApiError(
    404,
    "NOT_FOUND",
    "Document template was not found in this Project.",
  );
}

export class WorkspaceDocumentStudioTemplatesService {
  constructor(
    private readonly repository: WorkspaceDocumentStudioTemplatesRepository,
  ) {}

  list(projectId: string) {
    const id = Id.parse(projectId);
    try {
      return this.repository.listVisible(id);
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Document templates could not be read safely.",
      );
    }
  }

  get(projectId: string, templateId: string) {
    const project = Id.parse(projectId);
    const id = Id.parse(templateId);
    try {
      const template = this.repository.getVisible(project, id);
      return template ? safeTemplate(template) : notFound();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Document template could not be read safely.",
      );
    }
  }

  copy(input: { projectId: string; templateId: string; title?: string }) {
    const source = this.get(input.projectId, input.templateId);
    const title = Title.parse(input.title ?? `${source.title}（副本）`);
    try {
      const copied = this.repository.copyVisible({
        projectId: input.projectId,
        templateId: input.templateId,
        title,
      });
      return copied ? safeTemplate(copied) : notFound();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (
        /UNIQUE constraint failed: document_studio_templates.project_id, document_studio_templates.title/i.test(
          message,
        )
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "A local template with this title already exists in the Project.",
        );
      }
      if (/active Project/i.test(message)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Archived Projects are read-only.",
        );
      }
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Document template could not be copied safely.",
      );
    }
  }

  update(input: {
    projectId: string;
    templateId: string;
    title?: string;
    description?: string;
    content?: string;
    plan?: unknown;
  }) {
    const current = this.get(input.projectId, input.templateId);
    if (current.scope !== "project") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Built-in templates are immutable; copy one before editing it.",
      );
    }
    const title = Title.parse(input.title ?? current.title);
    const description = Description.parse(
      input.description ?? current.description,
    );
    const content = Content.parse(input.content ?? current.content);
    const plan = DocumentStudioDraftPlanV21Schema.parse(
      input.plan ?? current.plan,
    );
    try {
      const updated = this.repository.updateLocal({
        projectId: input.projectId,
        templateId: input.templateId,
        title,
        description,
        content,
        plan,
      });
      return updated ? safeTemplate(updated) : notFound();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (
        /UNIQUE constraint failed: document_studio_templates.project_id, document_studio_templates.title/i.test(
          message,
        )
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "A local template with this title already exists in the Project.",
        );
      }
      if (/active Project/i.test(message)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Archived Projects are read-only.",
        );
      }
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Document template could not be updated safely.",
      );
    }
  }
}
