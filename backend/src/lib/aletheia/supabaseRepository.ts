import { createServerSupabase } from "../supabase";
import {
  auditActionForWorkProduct,
  buildInitialAgentPlan,
} from "./domain";
import type {
  AddReviewInput,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  CreateAgentRunInput,
  CreateMatterInput,
  CreateWorkProductInput,
} from "./repository";

type Db = ReturnType<typeof createServerSupabase>;

export class SupabaseAletheiaRepository implements AletheiaRepository {
  constructor(private readonly db: Db = createServerSupabase()) {}

  async listMatters(ctx: AletheiaUserContext) {
    const { data, error } = await this.db.rpc("get_aletheia_matters_overview", {
      p_user_id: ctx.userId,
      p_user_email: ctx.userEmail ?? null,
    });
    if (error) throw error;
    return data ?? [];
  }

  async createMatter(ctx: AletheiaUserContext, input: CreateMatterInput) {
    const { data, error } = await this.db
      .from("aletheia_matters")
      .insert({
        user_id: ctx.userId,
        title: input.title,
        objective: input.objective,
        template: input.template,
        status: input.status,
        risk_level: input.riskLevel,
        client_or_project: input.clientOrProject,
        source_project_id: input.sourceProjectId,
        shared_with: input.sharedWith,
        metadata: input.metadata,
      })
      .select("*")
      .single();
    if (error) throw error;

    try {
      await this.writeAuditEvent(ctx.userId, data.id, {
        actor: "human",
        action: "matter_created",
        workflowVersion: "aletheia-v0",
        model: null,
        details: { template: input.template, status: input.status },
      });
      await this.createInitialAgentPlan(ctx.userId, {
        matterId: data.id,
        template: input.template,
        objective: input.objective,
        riskLevel: input.riskLevel,
      });
    } catch (auditError) {
      console.warn("[aletheia] failed to write initial matter audit scaffold", auditError);
    }

    return data;
  }

  async getMatterDetail(ctx: AletheiaUserContext, matterId: string) {
    const matter = await this.loadMatterForAccess(ctx, matterId);
    if (!matter) return null;

    const [
      { data: documents, error: documentsError },
      { data: workProducts, error: workProductsError },
      { data: evidence, error: evidenceError },
      { data: reviews, error: reviewsError },
      { data: auditEvents, error: auditError },
      { data: agentRuns, error: agentRunsError },
    ] = await Promise.all([
      this.db
        .from("aletheia_matter_documents")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: true }),
      this.db
        .from("aletheia_work_products")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: true }),
      this.db
        .from("aletheia_evidence_items")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: true }),
      this.db
        .from("aletheia_review_items")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: false }),
      this.db
        .from("aletheia_audit_events")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: false }),
      this.db
        .from("aletheia_agent_runs")
        .select("*, steps:aletheia_agent_steps(*), tool_calls:aletheia_tool_calls(*), human_checkpoints:aletheia_human_checkpoints(*)")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: false }),
    ]);

    const firstError =
      documentsError ??
      workProductsError ??
      evidenceError ??
      reviewsError ??
      auditError ??
      agentRunsError;
    if (firstError) throw firstError;

    return {
      matter,
      documents: documents ?? [],
      workProducts: workProducts ?? [],
      evidence: evidence ?? [],
      reviews: reviews ?? [],
      auditEvents: auditEvents ?? [],
      agentRuns: agentRuns ?? [],
    };
  }

  async createWorkProduct(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateWorkProductInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data, error } = await this.db
      .from("aletheia_work_products")
      .insert({
        matter_id: matterId,
        user_id: ctx.userId,
        kind: input.kind,
        title: input.title,
        status: input.status,
        schema_version: input.schemaVersion,
        content: input.content,
        validation_errors: input.validationErrors,
        generated_by: input.generatedBy,
        model: input.model,
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: input.generatedBy,
      action: auditActionForWorkProduct(input.kind),
      workflowVersion: input.schemaVersion,
      model: input.model,
      details: {
        workProductId: data.id,
        kind: input.kind,
        title: input.title,
        status: input.status,
      },
    });
    await this.touchMatter(matterId, ctx.userId);
    return data;
  }

  async addReview(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddReviewInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data, error } = await this.db
      .from("aletheia_review_items")
      .insert({
        matter_id: matterId,
        work_product_id: input.workProductId,
        evidence_item_id: input.evidenceItemId,
        target_type: input.targetType,
        target_id: input.targetId,
        tag: input.tag,
        comment: input.comment,
        reviewer_user_id: ctx.userId,
        reviewer_name: input.reviewerName,
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "review_added",
      workflowVersion: "aletheia-v0",
      model: null,
      details: {
        targetType: input.targetType,
        targetId: input.targetId,
        tag: input.tag,
        reviewId: data.id,
      },
    });
    return data;
  }

  async appendAuditEvent(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AppendAuditEventInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    return this.writeAuditEvent(ctx.userId, matterId, input);
  }

  async createAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateAgentRunInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data, error } = await this.db
      .from("aletheia_agent_runs")
      .insert({
        matter_id: matterId,
        user_id: ctx.userId,
        workflow: input.workflow,
        goal: input.goal,
        status: input.status ?? "queued",
        model_profile: input.modelProfile ?? null,
        storage_driver: "supabase",
        metadata: input.metadata ?? {},
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "agent_run_created",
      workflowVersion: "aletheia-agent-runtime-v0",
      model: input.modelProfile ?? null,
      details: { agentRunId: data.id, workflow: input.workflow },
    });
    return data;
  }

  private async loadMatterForAccess(ctx: AletheiaUserContext, matterId: string) {
    const { data, error } = await this.db
      .from("aletheia_matters")
      .select("*")
      .eq("id", matterId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const sharedWith = Array.isArray(data.shared_with) ? data.shared_with : [];
    const canAccess =
      data.user_id === ctx.userId ||
      (Boolean(ctx.userEmail) && sharedWith.includes(ctx.userEmail));
    return canAccess ? data : null;
  }

  private async loadOwnedMatter(ctx: AletheiaUserContext, matterId: string) {
    const matter = await this.loadMatterForAccess(ctx, matterId);
    if (!matter || matter.user_id !== ctx.userId) return null;
    return matter;
  }

  private async writeAuditEvent(
    userId: string,
    matterId: string,
    input: AppendAuditEventInput,
  ) {
    const { data, error } = await this.db
      .from("aletheia_audit_events")
      .insert({
        matter_id: matterId,
        user_id: userId,
        actor: input.actor,
        action: input.action,
        workflow_version: input.workflowVersion ?? "aletheia-v0",
        model: input.model,
        details: input.details,
      })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  private async createInitialAgentPlan(
    userId: string,
    args: {
      matterId: string;
      template: string;
      objective: string;
      riskLevel: string | null;
    },
  ) {
    const content = buildInitialAgentPlan(args);
    const { data, error } = await this.db
      .from("aletheia_work_products")
      .insert({
        matter_id: args.matterId,
        user_id: userId,
        kind: "agent_plan",
        title: "Initial Agent Plan",
        status: "generated",
        schema_version: "aletheia-agent-plan-v0",
        content,
        validation_errors: [],
        generated_by: "system",
        model: null,
      })
      .select("id")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(userId, args.matterId, {
      actor: "system",
      action: "agent_plan_generated",
      workflowVersion: "aletheia-agent-plan-v0",
      model: null,
      details: {
        workProductId: data.id,
        template: args.template,
        source: "deterministic_scaffold",
      },
    });
  }

  private async touchMatter(matterId: string, userId: string) {
    await this.db
      .from("aletheia_matters")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", matterId)
      .eq("user_id", userId);
  }
}
