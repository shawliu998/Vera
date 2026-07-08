export type AletheiaUserContext = {
  userId: string;
  userEmail?: string;
};

export type CreateMatterInput = {
  title: string;
  objective: string;
  template: string;
  status: string;
  riskLevel: string | null;
  clientOrProject: string | null;
  sourceProjectId: string | null;
  sharedWith: string[];
  metadata: Record<string, unknown>;
};

export type CreateWorkProductInput = {
  kind: string;
  title: string;
  status: string;
  schemaVersion: string;
  content: Record<string, unknown>;
  validationErrors: unknown[];
  generatedBy: "system" | "agent" | "human";
  model: string | null;
};

export type AddReviewInput = {
  targetType: string;
  targetId: string;
  tag: string;
  comment: string;
  workProductId: string | null;
  evidenceItemId: string | null;
  reviewerName: string | null;
};

export type AppendAuditEventInput = {
  actor: "system" | "agent" | "human";
  action: string;
  workflowVersion: string | null;
  model: string | null;
  details: Record<string, unknown>;
};

export type CreateAgentRunInput = {
  workflow: string;
  goal: string;
  status?: "queued" | "running";
  modelProfile?: string | null;
  metadata?: Record<string, unknown>;
};

export interface AletheiaRepository {
  listMatters(ctx: AletheiaUserContext): Promise<unknown[]>;
  createMatter(ctx: AletheiaUserContext, input: CreateMatterInput): Promise<unknown>;
  getMatterDetail(ctx: AletheiaUserContext, matterId: string): Promise<unknown | null>;
  createWorkProduct(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateWorkProductInput,
  ): Promise<unknown | null>;
  addReview(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddReviewInput,
  ): Promise<unknown | null>;
  appendAuditEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AppendAuditEventInput,
  ): Promise<unknown | null>;
  createAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateAgentRunInput,
  ): Promise<unknown | null>;
}

export class LocalAdapterNotReadyError extends Error {
  constructor() {
    super(
      "Aletheia local storage adapter is scaffolded but not enabled for API traffic yet",
    );
    this.name = "LocalAdapterNotReadyError";
  }
}
