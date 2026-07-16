import { z } from "zod";

import type { MatterPolicy } from "../../../matter/profile/contracts";
import {
  AssistantLegalAuthorityEvidenceSchema,
  type AssistantLegalAuthorityEvidence,
  type AssistantModelToolCall,
  type AssistantToolContext,
} from "./assistantRuntime";
import type { AssistantToolModule } from "./assistantToolRegistry";
import {
  LEGAL_RESEARCH_TOOL_ADAPTER_ID,
  LEGAL_RESEARCH_TOOL_MODULE_ID,
  type LegalResearchToolContext,
  type LegalResearchToolName,
  WorkspaceLegalResearchTools,
} from "./legalResearchTools";

const MAX_LEGAL_TOOL_RESULT_CHARS = 180 * 1_024;

const DurableReadResultSchema = z
  .object({
    snapshotId: z.string().uuid(),
    durable: z.literal(true),
    sourceRef: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(500),
    excerpts: z
      .array(
        z
          .object({
            anchorCandidateId: z.string().uuid(),
            text: z.string().min(1).max(8_000),
            locator: z
              .object({
                article: z.string().trim().min(1).max(500).optional(),
                section: z.string().trim().min(1).max(500).optional(),
                paragraph: z.string().trim().min(1).max(500).optional(),
                page: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .passthrough();

export interface AssistantLegalResearchMatterPolicyPort {
  get(projectId: string): MatterPolicy | null;
}

export interface AssistantLegalResearchEvidencePort {
  assistantEvidenceForCapturedRead(input: {
    owner: {
      projectId: string;
      jobId: string;
      attempt: number;
      leaseOwner: string;
      researchSessionId: string;
    };
    sourceRef: string;
    snapshotId: string;
    anchorIds: readonly string[];
  }): readonly AssistantLegalAuthorityEvidence[];
}

export class AssistantLegalResearchPolicyError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(
    message = "External legal research is not allowed for this Matter.",
  ) {
    super(message);
    this.name = "AssistantLegalResearchPolicyError";
  }
}

function legalContext(context: AssistantToolContext): LegalResearchToolContext {
  if (!context.projectId) throw new AssistantLegalResearchPolicyError();
  return {
    projectId: context.projectId,
    researchSessionId: `${context.jobId}:${context.attempt}`,
    jobId: context.jobId,
    attempt: context.attempt,
    leaseOwner: context.leaseOwner,
    // The Workspace Assistant does not yet carry a trustworthy local-model
    // attestation. Treat execution as remote; a production-ready provider must
    // therefore declare remote model-use rights. Technical PoC grants remain
    // an explicit, non-durable exception in the provider status contract.
    modelExecution: "remote",
  };
}

function policyAllowsExternalLegalResearch(
  context: AssistantToolContext,
  policies: AssistantLegalResearchMatterPolicyPort,
) {
  if (!context.projectId) return false;
  const policy = policies.get(context.projectId);
  return (
    policy?.projectId === context.projectId &&
    policy?.allowExternalLegalSources === true &&
    policy.externalEgressMode === "allowed_by_policy"
  );
}

/**
 * Assistant-facing legal research module. It deliberately emits no document
 * sourceContext because technical PoC legal content is transient and cannot be
 * represented by the current durable document-only citation schema.
 */
export class WorkspaceAssistantLegalResearchToolModule implements AssistantToolModule {
  readonly id = LEGAL_RESEARCH_TOOL_MODULE_ID;
  readonly adapterId = LEGAL_RESEARCH_TOOL_ADAPTER_ID;

  constructor(
    private readonly delegate: WorkspaceLegalResearchTools,
    private readonly policies: AssistantLegalResearchMatterPolicyPort,
    private readonly evidence: AssistantLegalResearchEvidencePort | null = null,
  ) {}

  private assertMatterPolicy(context: AssistantToolContext) {
    if (!policyAllowsExternalLegalResearch(context, this.policies)) {
      throw new AssistantLegalResearchPolicyError();
    }
  }

  async registeredTools(context: AssistantToolContext) {
    if (!policyAllowsExternalLegalResearch(context, this.policies)) return [];
    return this.delegate.registeredTools(legalContext(context));
  }

  async assertModelUse(context: AssistantToolContext) {
    this.assertMatterPolicy(context);
    const status = await this.delegate.status(legalContext(context));
    if (!status.toolUseAllowed) throw new AssistantLegalResearchPolicyError();
  }

  async execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    this.assertMatterPolicy(input.context);
    const value = await this.delegate.execute({
      context: legalContext(input.context),
      call: {
        name: input.call.name as LegalResearchToolName,
        input: input.call.input,
      },
      signal: input.signal,
    });
    const content = JSON.stringify(value);
    if (content.length > MAX_LEGAL_TOOL_RESULT_CHARS) {
      throw new AssistantLegalResearchPolicyError(
        "Legal research tool result exceeds the Assistant context boundary.",
      );
    }
    if (input.call.name !== "read_legal_source") {
      return { content, sourceContext: [], legalAuthoritySourceContext: [] };
    }
    const durableRead = DurableReadResultSchema.safeParse(value);
    // Technical PoC/transient reads may inform the current model turn, but they
    // are intentionally ineligible for citations or durable message ownership.
    if (!durableRead.success) {
      const transient = z
        .object({ durable: z.literal(false), snapshotId: z.null() })
        .passthrough()
        .safeParse(value);
      if (transient.success) {
        return { content, sourceContext: [], legalAuthoritySourceContext: [] };
      }
      throw new AssistantLegalResearchPolicyError(
        "Legal authority read did not return a durable captured source.",
      );
    }
    if (!this.evidence) {
      throw new AssistantLegalResearchPolicyError(
        "Durable legal authority evidence verification is unavailable.",
      );
    }
    const context = legalContext(input.context);
    const verified = z
      .array(AssistantLegalAuthorityEvidenceSchema)
      .min(1)
      .max(50)
      .parse(
        this.evidence.assistantEvidenceForCapturedRead({
          owner: {
            projectId: context.projectId,
            jobId: input.context.jobId,
            attempt: input.context.attempt,
            leaseOwner: input.context.leaseOwner,
            researchSessionId: context.researchSessionId,
          },
          sourceRef: durableRead.data.sourceRef,
          snapshotId: durableRead.data.snapshotId,
          anchorIds: durableRead.data.excerpts.map(
            (excerpt) => excerpt.anchorCandidateId,
          ),
        }),
      );
    const returnedByAnchor = new Map(
      durableRead.data.excerpts.map((excerpt) => [
        excerpt.anchorCandidateId,
        excerpt,
      ]),
    );
    if (
      verified.length !== durableRead.data.excerpts.length ||
      verified.some((authority) => {
        const excerpt = returnedByAnchor.get(authority.anchorId);
        return (
          authority.projectId !== input.context.projectId ||
          authority.jobId !== input.context.jobId ||
          authority.attempt !== input.context.attempt ||
          authority.snapshotId !== durableRead.data.snapshotId ||
          authority.sourceRef !== durableRead.data.sourceRef ||
          authority.title !== durableRead.data.title ||
          !excerpt ||
          authority.exactQuote !== excerpt.text ||
          JSON.stringify(authority.locator) !==
            JSON.stringify(excerpt.locator ?? {})
        );
      })
    ) {
      throw new AssistantLegalResearchPolicyError(
        "Legal authority read no longer matches its durable snapshot and anchors.",
      );
    }
    return {
      content,
      sourceContext: [],
      legalAuthoritySourceContext: verified,
    };
  }
}
