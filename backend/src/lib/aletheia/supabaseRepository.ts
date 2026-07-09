import { createServerSupabase } from "../supabase";
import {
  GATE_AUDIT_ACTIONS,
  auditActionForWorkProduct,
  buildGateSnapshotAuditDetails,
  buildAgentRunTraceScaffold,
  buildAgentWorkflowGraph,
  buildDeterministicDraftMemoContent,
  buildInitialAgentPlan,
  deriveClaimSuggestionFromText,
  normalizedFactFromQuote,
  professionalDraftProfileForTemplate,
  buildSourceLinkedIssueMapContent,
  buildSourceLinkedEvidenceMatrixContent,
} from "./domain";
import {
  ApprovalRequiredError,
  CapabilityNotAvailableError,
} from "./repository";
import type {
  AddMatterMemoryInput,
  AddReviewInput,
  AgentRunBudget,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  CreateAgentRunInput,
  CreateEvidenceItemInput,
  CreateMatterInput,
  CreatePlaybookInput,
  ProposePlaybookImprovementInput,
  CreateWorkProductInput,
  DecideApprovalInput,
  ListV1SourceIndexInput,
  PersistGateSnapshotInput,
  ResumeAgentRunInput,
  RequestApprovalInput,
  SearchMatterDocumentsInput,
  UploadMatterDocumentInput,
} from "./repository";

type Db = ReturnType<typeof createServerSupabase>;

function numberOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArrayFromObject(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function defaultRunBudget(input?: AgentRunBudget) {
  return {
    maxSteps: numberOrDefault(input?.maxSteps, 7),
    maxToolCalls: numberOrDefault(input?.maxToolCalls, 12),
    maxTokens: numberOrNull(input?.maxTokens),
    maxCostUsd: numberOrNull(input?.maxCostUsd),
    maxWallTimeMs: numberOrDefault(input?.maxWallTimeMs, 600000),
  };
}

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
      console.warn(
        "[aletheia] failed to write initial matter audit scaffold",
        auditError,
      );
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
      { data: matterMemory, error: matterMemoryError },
      { data: playbooks, error: playbooksError },
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
        .select(
          "*, steps:aletheia_agent_steps(*), tool_calls:aletheia_tool_calls(*), human_checkpoints:aletheia_human_checkpoints(*)",
        )
        .eq("matter_id", matterId)
        .order("created_at", { ascending: false }),
      this.db
        .from("aletheia_matter_memory_items")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: false }),
      this.db
        .from("aletheia_playbooks")
        .select("*")
        .eq("matter_id", matterId)
        .order("created_at", { ascending: false }),
    ]);

    const firstError =
      documentsError ??
      workProductsError ??
      evidenceError ??
      reviewsError ??
      auditError ??
      agentRunsError ??
      matterMemoryError ??
      playbooksError;
    if (firstError) throw firstError;

    return {
      matter,
      documents: documents ?? [],
      workProducts: workProducts ?? [],
      evidence: evidence ?? [],
      reviews: reviews ?? [],
      auditEvents: auditEvents ?? [],
      agentRuns: agentRuns ?? [],
      matterMemory: matterMemory ?? [],
      playbooks: playbooks ?? [],
    };
  }

  async createWorkProduct(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateWorkProductInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const approvalAction =
      input.kind === "audit_pack"
        ? "audit_pack_export"
        : input.kind === "feedback_export"
          ? "feedback_dataset_export"
          : input.kind === "final_memo"
            ? "final_memo_export"
            : null;
    if (approvalAction) {
      const approved = await this.loadApprovedApprovalCheckpoint(
        ctx,
        matterId,
        input.approvalCheckpointId ?? null,
        approvalAction,
      );
      if (!approved) {
        throw new ApprovalRequiredError(
          `${input.kind.replaceAll("_", " ")} requires an approved human checkpoint.`,
        );
      }
    }
    const gateEvidence =
      input.kind === "final_memo"
        ? await this.persistFinalMemoGateAuthorization(
            ctx,
            matterId,
            input.content,
            input.approvalCheckpointId ?? null,
          )
        : null;
    const content = gateEvidence
      ? {
          ...input.content,
          persistedGateEvidence: {
            schemaVersion: "aletheia-final-memo-gate-evidence-v0",
            gateSnapshotAuditEventId: gateEvidence.gateSnapshotAuditEventId,
            gateAuthorizationAuditEventId:
              gateEvidence.gateAuthorizationAuditEventId,
          },
        }
      : input.content;

    const { data, error } = await this.db
      .from("aletheia_work_products")
      .insert({
        matter_id: matterId,
        user_id: ctx.userId,
        kind: input.kind,
        title: input.title,
        status: input.status,
        schema_version: input.schemaVersion,
        content,
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
        approvalCheckpointId: input.approvalCheckpointId ?? null,
        gateSnapshotAuditEventId:
          gateEvidence?.gateSnapshotAuditEventId ?? null,
        gateAuthorizationAuditEventId:
          gateEvidence?.gateAuthorizationAuditEventId ?? null,
      },
    });
    await this.touchMatter(matterId, ctx.userId);
    return data;
  }

  async requestApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    input: RequestApprovalInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    let runId = await this.latestAgentRunId(matterId, ctx.userId);
    if (!runId) {
      await this.createAgentRun(ctx, matterId, {
        workflow: matter.template,
        goal: `Approval gate for ${input.action}`,
        status: "queued",
        metadata: { source: "approval_request", action: input.action },
      });
      runId = await this.latestAgentRunId(matterId, ctx.userId);
    }
    if (!runId) return null;

    const { data: existing, error: existingError } = await this.db
      .from("aletheia_human_checkpoints")
      .select("*")
      .eq("matter_id", matterId)
      .eq("user_id", ctx.userId)
      .eq("checkpoint_type", input.action)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return existing;

    const stepKey =
      input.action === "audit_pack_export"
        ? "audit_export_gate"
        : "human_review";
    const { data: step, error: stepError } = await this.db
      .from("aletheia_agent_steps")
      .select("id")
      .eq("run_id", runId)
      .eq("step_key", stepKey)
      .order("sequence", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (stepError) throw stepError;

    const { data, error } = await this.db
      .from("aletheia_human_checkpoints")
      .insert({
        run_id: runId,
        step_id: step?.id ?? null,
        matter_id: matterId,
        user_id: ctx.userId,
        checkpoint_type: input.action,
        status: "open",
        prompt:
          input.prompt ??
          `Approve ${input.action.replaceAll("_", " ")} before execution.`,
        requested_payload: {
          action: input.action,
          matterId,
          ...(input.requestedPayload ?? {}),
        },
        decision_payload: {},
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "approval_requested",
      workflowVersion: "aletheia-approval-v0",
      model: null,
      details: { checkpointId: data.id, action: input.action },
    });
    return data;
  }

  async decideApproval(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string,
    input: DecideApprovalInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data: checkpoint, error: checkpointError } = await this.db
      .from("aletheia_human_checkpoints")
      .select("*")
      .eq("id", checkpointId)
      .eq("matter_id", matterId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (checkpointError) throw checkpointError;
    if (!checkpoint) return null;
    if (
      ![
        "audit_pack_export",
        "feedback_dataset_export",
        "final_memo_export",
      ].includes(checkpoint.checkpoint_type)
    ) {
      throw new ApprovalRequiredError(
        "Only high-risk approval checkpoints can be decided here.",
      );
    }

    const decidedAt = new Date().toISOString();
    const resolvedStatus =
      input.decision === "approved" || input.decision === "rejected"
        ? input.decision
        : "resolved";
    const { data, error } = await this.db
      .from("aletheia_human_checkpoints")
      .update({
        status: resolvedStatus,
        decision: input.decision,
        decision_payload: {
          comment: input.comment ?? null,
          editedPayload: input.editedPayload ?? null,
          response: input.response ?? null,
        },
        decided_by: ctx.userId,
        decided_at: decidedAt,
      })
      .eq("id", checkpointId)
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action:
        input.decision === "approved"
          ? "approval_approved"
          : input.decision === "rejected"
            ? "approval_rejected"
            : input.decision === "edited"
              ? "approval_edited"
              : "approval_responded",
      workflowVersion: "aletheia-approval-v0",
      model: null,
      details: {
        checkpointId,
        action: checkpoint.checkpoint_type,
        decision: input.decision,
        comment: input.comment ?? null,
        editedPayload: input.editedPayload ?? null,
        response: input.response ?? null,
      },
    });
    return data;
  }

  async addMatterMemory(
    ctx: AletheiaUserContext,
    matterId: string,
    input: AddMatterMemoryInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data, error } = await this.db
      .from("aletheia_matter_memory_items")
      .insert({
        matter_id: matterId,
        user_id: ctx.userId,
        category: input.category,
        title: input.title,
        body: input.body,
        source: input.source ?? "human",
        metadata: input.metadata ?? {},
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "matter_memory_added",
      workflowVersion: "aletheia-memory-v0",
      model: null,
      details: { memoryItemId: data.id, category: input.category },
    });
    await this.touchMatter(matterId, ctx.userId);
    return data;
  }

  async createPlaybook(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreatePlaybookInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data, error } = await this.db
      .from("aletheia_playbooks")
      .insert({
        matter_id: matterId,
        user_id: ctx.userId,
        name: input.name,
        description: input.description,
        version: input.version ?? "v0.1",
        status: "draft",
        content: input.content,
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "playbook_drafted",
      workflowVersion: "aletheia-playbook-v0",
      model: null,
      details: { playbookId: data.id, name: input.name },
    });
    await this.touchMatter(matterId, ctx.userId);
    return data;
  }

  async approvePlaybook(
    ctx: AletheiaUserContext,
    matterId: string,
    playbookId: string,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const approvedAt = new Date().toISOString();
    const { data, error } = await this.db
      .from("aletheia_playbooks")
      .update({
        status: "approved",
        approved_by: ctx.userId,
        approved_at: approvedAt,
        updated_at: approvedAt,
      })
      .eq("id", playbookId)
      .eq("matter_id", matterId)
      .eq("user_id", ctx.userId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "playbook_approved",
      workflowVersion: "aletheia-playbook-v0",
      model: null,
      details: { playbookId },
    });
    await this.touchMatter(matterId, ctx.userId);
    return data;
  }

  async proposePlaybookImprovement(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: ProposePlaybookImprovementInput,
  ) {
    throw new CapabilityNotAvailableError(
      "Playbook improvement proposals are currently available only in local Aletheia storage mode.",
    );
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

  async persistGateSnapshot(
    ctx: AletheiaUserContext,
    matterId: string,
    input: PersistGateSnapshotInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const snapshot = buildGateSnapshotAuditDetails({
      matterId,
      action: input.action,
      approvalCheckpointId: input.approvalCheckpointId ?? null,
      content: input.content,
    });
    return this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: GATE_AUDIT_ACTIONS.resultsPersisted,
      workflowVersion: snapshot.details.schemaVersion,
      model: null,
      details: snapshot.details,
    });
  }

  async createAgentRun(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateAgentRunInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const scaffold = buildAgentRunTraceScaffold({
      workflow: input.workflow,
      goal: input.goal,
      matterId,
    });
    const metadata = {
      ...(input.metadata ?? {}),
      workflowGraph: buildAgentWorkflowGraph(scaffold),
    };

    const { data, error } = await this.db
      .from("aletheia_agent_runs")
      .insert({
        matter_id: matterId,
        user_id: ctx.userId,
        workflow: input.workflow,
        goal: input.goal,
        status: input.status === "running" ? "running" : "needs_human",
        current_step_key:
          input.status === "running" ? "parse_documents" : "human_review",
        model_profile: input.modelProfile ?? null,
        storage_driver: "supabase",
        budget: defaultRunBudget(input.budget),
        metadata,
        started_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.createAgentRunTraceScaffold(ctx.userId, matterId, data.id, {
      workflow: input.workflow,
      goal: input.goal,
    });
    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: "agent_run_created",
      workflowVersion: "aletheia-agent-runtime-v0",
      model: input.modelProfile ?? null,
      details: {
        agentRunId: data.id,
        workflow: input.workflow,
        budget: defaultRunBudget(input.budget),
      },
    });
    return {
      ...data,
      steps: [],
      tool_calls: [],
      human_checkpoints: [],
    };
  }

  async persistV1RuntimeResult() {
    throw new CapabilityNotAvailableError(
      "V1 runtime result persistence is currently available only in local Aletheia storage mode.",
    );
  }

  async resumeAgentRun(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _runId: string,
    _input: ResumeAgentRunInput,
  ) {
    throw new CapabilityNotAvailableError(
      "Agent run resume is currently available only in local Aletheia storage mode.",
    );
  }

  async createEvidenceItem(
    ctx: AletheiaUserContext,
    matterId: string,
    input: CreateEvidenceItemInput,
  ) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data: chunk, error: chunkError } = await this.db
      .from("aletheia_document_chunks")
      .select(
        "id, matter_document_id, page, section, text, quote_start, quote_end, metadata",
      )
      .eq("id", input.sourceChunkId)
      .eq("matter_id", matterId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (chunkError) throw chunkError;
    if (!chunk) return null;

    const { data: document, error: documentError } = await this.db
      .from("aletheia_matter_documents")
      .select("id, name")
      .eq("id", chunk.matter_document_id)
      .eq("matter_id", matterId)
      .maybeSingle();
    if (documentError) throw documentError;
    const suggestedClaim = deriveClaimSuggestionFromText(chunk.text);
    const claimId =
      typeof input.claimId === "string" && input.claimId.trim()
        ? input.claimId.trim()
        : suggestedClaim.claimId;
    const chunkMetadata = objectOrEmpty(chunk.metadata);

    const { data, error } = await this.db
      .from("aletheia_evidence_items")
      .insert({
        matter_id: matterId,
        work_product_id: input.workProductId ?? null,
        document_id: chunk.matter_document_id,
        source_chunk_id: chunk.id,
        claim_id: claimId,
        document_name: document?.name ?? null,
        page: chunk.page ?? null,
        section: chunk.section ?? null,
        quote: chunk.text,
        quote_start: chunk.quote_start ?? null,
        quote_end: chunk.quote_end ?? null,
        relevance: input.relevance,
        support_status: input.supportStatus,
        confidence: input.confidence ?? null,
        metadata: {
          source: "source_document_chunk",
          matterDocumentId: chunk.matter_document_id,
          normalizedFact: normalizedFactFromQuote(chunk.text),
          sensitiveMaterialFlags: stringArrayFromObject(
            chunkMetadata.sensitiveMaterialFlags,
          ),
          claimSuggestion:
            claimId === suggestedClaim.claimId ? suggestedClaim : null,
          ...(input.metadata ?? {}),
        },
      })
      .select("*")
      .single();
    if (error) throw error;

    await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "human",
      action: "evidence_mapped",
      workflowVersion: "aletheia-v0",
      model: null,
      details: {
        evidenceItemId: data.id,
        sourceChunkId: input.sourceChunkId,
        matterDocumentId: chunk.matter_document_id,
        claimId,
        supportStatus: input.supportStatus,
        relevance: input.relevance,
      },
    });
    await this.touchMatter(matterId, ctx.userId);
    return data;
  }

  async generateEvidenceMatrix(ctx: AletheiaUserContext, matterId: string) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data: evidence, error } = await this.db
      .from("aletheia_evidence_items")
      .select("*")
      .eq("matter_id", matterId)
      .order("created_at", { ascending: true });
    if (error) throw error;

    return this.createWorkProduct(ctx, matterId, {
      kind: "evidence_matrix",
      title: `${matter.title} Evidence Matrix`,
      status: evidence?.length ? "generated" : "needs_review",
      schemaVersion: "aletheia-evidence-matrix-v0",
      content: buildSourceLinkedEvidenceMatrixContent({
        matter,
        evidence: evidence ?? [],
      }),
      validationErrors: evidence?.length
        ? []
        : ["Evidence matrix has no source-linked evidence items yet."],
      generatedBy: "system",
      model: null,
    });
  }

  async generateIssueMap(ctx: AletheiaUserContext, matterId: string) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;

    const { data: evidence, error } = await this.db
      .from("aletheia_evidence_items")
      .select("*")
      .eq("matter_id", matterId)
      .order("created_at", { ascending: true });
    if (error) throw error;

    return this.createWorkProduct(ctx, matterId, {
      kind: "issue_map",
      title: `${matter.title} Issue Map`,
      status: evidence?.length ? "generated" : "needs_review",
      schemaVersion: "aletheia-issue-map-v0",
      content: buildSourceLinkedIssueMapContent({
        matter,
        evidence: evidence ?? [],
      }),
      validationErrors: evidence?.length
        ? []
        : ["Issue map has no source-linked evidence items yet."],
      generatedBy: "system",
      model: null,
    });
  }

  async generateDraftMemo(ctx: AletheiaUserContext, matterId: string) {
    const matter = await this.loadOwnedMatter(ctx, matterId);
    if (!matter) return null;
    const draftProfile = professionalDraftProfileForTemplate(matter.template);

    const { data: matrix, error: matrixError } = await this.db
      .from("aletheia_work_products")
      .select("*")
      .eq("matter_id", matterId)
      .eq("user_id", ctx.userId)
      .eq("kind", "evidence_matrix")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (matrixError) throw matrixError;

    const { data: evidence, error: evidenceError } = await this.db
      .from("aletheia_evidence_items")
      .select("*")
      .eq("matter_id", matterId)
      .order("created_at", { ascending: true });
    if (evidenceError) throw evidenceError;

    const fallbackMatrix = buildSourceLinkedEvidenceMatrixContent({
      matter,
      evidence: evidence ?? [],
    });
    const validationErrors = [
      ...(matrix
        ? []
        : [
            "No persisted evidence matrix was found; draft used a generated fallback matrix.",
          ]),
      ...(evidence?.length
        ? []
        : ["Draft memo has no source-linked evidence items yet."]),
    ];

    return this.createWorkProduct(ctx, matterId, {
      kind: draftProfile.kind,
      title: `${matter.title} ${draftProfile.titleSuffix}`,
      status: validationErrors.length ? "needs_review" : "generated",
      schemaVersion: draftProfile.schemaVersion,
      content: buildDeterministicDraftMemoContent({
        matter,
        evidenceMatrix: matrix?.content ?? fallbackMatrix,
        matrixWorkProductId: matrix?.id ?? null,
      }),
      validationErrors,
      generatedBy: "system",
      model: null,
    });
  }

  async uploadMatterDocument(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: UploadMatterDocumentInput,
  ): Promise<unknown | null> {
    throw new CapabilityNotAvailableError(
      "Aletheia document upload is available in local storage mode; Supabase document upload is not implemented yet.",
    );
  }

  async searchMatterDocuments(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: SearchMatterDocumentsInput,
  ): Promise<unknown[] | null> {
    throw new CapabilityNotAvailableError(
      "Aletheia document search is available in local storage mode; Supabase document search is not implemented yet.",
    );
  }

  async listV1SourceIndex(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: ListV1SourceIndexInput = {},
  ): Promise<unknown | null> {
    throw new CapabilityNotAvailableError(
      "V1 document/chunk/source listing is currently available only in local Aletheia storage mode; Supabase V1 document retrieval is not implemented yet.",
    );
  }

  private async loadMatterForAccess(
    ctx: AletheiaUserContext,
    matterId: string,
  ) {
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

  private async latestAgentRunId(matterId: string, userId: string) {
    const { data, error } = await this.db
      .from("aletheia_agent_runs")
      .select("id")
      .eq("matter_id", matterId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return typeof data?.id === "string" ? data.id : null;
  }

  private async loadApprovedApprovalCheckpoint(
    ctx: AletheiaUserContext,
    matterId: string,
    checkpointId: string | null,
    action: string,
  ) {
    if (!checkpointId) return null;
    const { data, error } = await this.db
      .from("aletheia_human_checkpoints")
      .select("*")
      .eq("id", checkpointId)
      .eq("matter_id", matterId)
      .eq("user_id", ctx.userId)
      .eq("checkpoint_type", action)
      .eq("status", "approved")
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  private async persistFinalMemoGateAuthorization(
    ctx: AletheiaUserContext,
    matterId: string,
    content: Record<string, unknown>,
    approvalCheckpointId: string | null,
  ) {
    const snapshot = buildGateSnapshotAuditDetails({
      matterId,
      action: "final_memo_export",
      approvalCheckpointId,
      content,
    });
    const snapshotEvent = (await this.writeAuditEvent(ctx.userId, matterId, {
      actor: "system",
      action: GATE_AUDIT_ACTIONS.resultsPersisted,
      workflowVersion: snapshot.details.schemaVersion,
      model: null,
      details: snapshot.details,
    })) as { id?: string } | null;

    if (!snapshot.ok) {
      await this.writeAuditEvent(ctx.userId, matterId, {
        actor: "system",
        action: GATE_AUDIT_ACTIONS.finalExportBlocked,
        workflowVersion: snapshot.details.schemaVersion,
        model: null,
        details: {
          schemaVersion: snapshot.details.schemaVersion,
          action: "final_memo_export",
          matterId,
          approvalCheckpointId,
          gateSnapshotAuditEventId: snapshotEvent?.id ?? null,
          failureReasons: snapshot.failures,
        },
      });
      throw new ApprovalRequiredError(
        `Final memo export requires a persisted passing gate snapshot: ${snapshot.failures.join(" ")}`,
      );
    }

    const authorizationEvent = (await this.writeAuditEvent(
      ctx.userId,
      matterId,
      {
        actor: "system",
        action: GATE_AUDIT_ACTIONS.finalExportAuthorized,
        workflowVersion: snapshot.details.schemaVersion,
        model: null,
        details: {
          schemaVersion: snapshot.details.schemaVersion,
          action: "final_memo_export",
          matterId,
          approvalCheckpointId,
          gateSnapshotAuditEventId: snapshotEvent?.id ?? null,
          gateSummary: snapshot.details.gateSummary,
        },
      },
    )) as { id?: string } | null;

    return {
      gateSnapshotAuditEventId: snapshotEvent?.id ?? null,
      gateAuthorizationAuditEventId: authorizationEvent?.id ?? null,
    };
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

  private async createAgentRunTraceScaffold(
    userId: string,
    matterId: string,
    runId: string,
    input: { workflow: string; goal: string },
  ) {
    const scaffold = buildAgentRunTraceScaffold({
      workflow: input.workflow,
      goal: input.goal,
      matterId,
    });
    const stepIdsByKey = new Map<string, string>();

    for (const step of scaffold.steps) {
      const { data, error } = await this.db
        .from("aletheia_agent_steps")
        .insert({
          run_id: runId,
          matter_id: matterId,
          user_id: userId,
          step_key: step.stepKey,
          title: step.title,
          sequence: step.sequence,
          status: step.status,
          input: step.input,
          output: step.output,
          validation_errors: step.validationErrors,
          metrics: {
            durationMs:
              step.status === "completed" || step.status === "needs_human"
                ? 0
                : null,
          },
          started_at: new Date().toISOString(),
          completed_at:
            step.status === "completed" || step.status === "needs_human"
              ? new Date().toISOString()
              : null,
        })
        .select("id")
        .single();
      if (error) throw error;
      stepIdsByKey.set(step.stepKey, data.id);

      const toolCalls = step.toolCalls.map((call) => ({
        run_id: runId,
        step_id: data.id,
        matter_id: matterId,
        user_id: userId,
        tool_name: call.toolName,
        risk_level: call.riskLevel,
        status: call.status,
        input: call.input,
        output: call.output,
        metrics: {
          durationMs:
            call.status === "completed" ||
            call.status === "requires_confirmation"
              ? 0
              : null,
        },
        started_at: new Date().toISOString(),
        completed_at:
          call.status === "completed" || call.status === "requires_confirmation"
            ? new Date().toISOString()
            : null,
      }));
      if (toolCalls.length) {
        const { error: toolError } = await this.db
          .from("aletheia_tool_calls")
          .insert(toolCalls);
        if (toolError) throw toolError;
      }
    }

    if (scaffold.checkpoints.length) {
      const { error } = await this.db.from("aletheia_human_checkpoints").insert(
        scaffold.checkpoints.map((checkpoint) => ({
          run_id: runId,
          step_id: stepIdsByKey.get(checkpoint.stepKey) ?? null,
          matter_id: matterId,
          user_id: userId,
          checkpoint_type: checkpoint.checkpointType,
          status: checkpoint.status,
          prompt: checkpoint.prompt,
          requested_payload: checkpoint.requestedPayload,
          decision_payload: {},
        })),
      );
      if (error) throw error;
    }
  }

  private async touchMatter(matterId: string, userId: string) {
    await this.db
      .from("aletheia_matters")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", matterId)
      .eq("user_id", userId);
  }
}
