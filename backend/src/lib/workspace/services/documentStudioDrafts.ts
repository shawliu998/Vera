import { WorkspaceApiError } from "../errors";
import { z } from "zod";
import type {
  DocumentStudioDraftListCursor,
  DocumentStudioDraftSummaryPage,
  WorkspaceDocumentStudioDraftsRepository,
} from "../repositories/documentStudioDrafts";

export class WorkspaceDocumentStudioDraftsService {
  constructor(
    private readonly repository: WorkspaceDocumentStudioDraftsRepository,
  ) {}

  list(input: {
    projectId: string;
    limit?: number;
    cursor?: DocumentStudioDraftListCursor | null;
  }): DocumentStudioDraftSummaryPage {
    const parsed = z
      .object({
        projectId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z
          .object({
            updatedAt: z.string().datetime({ precision: 3 }),
            documentId: z.string().uuid(),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .safeParse({
        projectId: input.projectId,
        limit: input.limit,
        cursor: input.cursor,
      });
    if (!parsed.success) {
      throw new WorkspaceApiError(
        422,
        "VALIDATION_ERROR",
        "Draft summary request is invalid.",
      );
    }
    try {
      return this.repository.listProjectDrafts({
        projectId: parsed.data.projectId,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      });
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Draft summaries could not be read safely.",
      );
    }
  }
}
