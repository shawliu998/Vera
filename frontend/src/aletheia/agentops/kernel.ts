import {
  buildExportAuthorization,
  type ExportAuthorization,
} from "./exportPackage";
import type { ExportIntent } from "./gates";
import type { GateResult, ProfessionalSkill } from "./types";
import {
  createV1ModelProviderConfig,
  evaluateV1ProviderPolicy,
  type V1ModelProvider,
  type V1PrivacyMode,
  type V1ProviderPolicyDecision,
} from "./v1Runtime";

export const ALETHEIA_KERNEL_VERSION =
  "aletheia-kernel-local-first-2026-07-09" as const;

export const KERNEL_MODULES = [
  "local_vault",
  "agent_loop_runtime",
  "typed_artifact_graph",
  "permission_tool_policy",
  "review_gate_console",
  "audit_trace",
  "eval_replay",
  "human_approved_skills",
] as const;

export type KernelModule = (typeof KERNEL_MODULES)[number];

export const KERNEL_RUN_PHASES = [
  "observe",
  "plan",
  "act",
  "verify",
  "persist",
  "report",
] as const;

export type KernelRunPhase = (typeof KERNEL_RUN_PHASES)[number];

export const KERNEL_TOOL_CAPABILITIES = [
  "read_local_matter",
  "search_matter_documents",
  "read_source_evidence",
  "create_draft_artifact",
  "add_review_comment",
  "append_audit_event",
  "request_approval_gated_export",
  "call_local_or_deterministic_model",
  "call_external_model",
  "export_final",
  "modify_skill",
  "terminal",
  "browser_automation",
  "email",
  "web_search",
  "destructive_file_operation",
] as const;

export type KernelToolCapability = (typeof KERNEL_TOOL_CAPABILITIES)[number];

export type KernelToolPolicy = {
  can_read: boolean;
  can_write: boolean;
  can_call_model: boolean;
  can_use_external_model: boolean;
  can_export: boolean;
  can_modify_skill: boolean;
  allowed_tools: KernelToolCapability[];
  blocked_tools: KernelToolCapability[];
};

export type KernelToolPolicyDecision = {
  allowed: boolean;
  capability: KernelToolCapability;
  reason: string;
};

export type KernelDomainPack = {
  id: string;
  name: string;
  matter_type:
    | "due_diligence"
    | "legal_review"
    | "compliance_review"
    | "audit_review"
    | "regulatory_response"
    | "other";
  kernel_modules: KernelModule[];
  artifact_focus: string[];
  gate_focus: GateResult["gate_type"][];
};

export type KernelProfile = {
  version: typeof ALETHEIA_KERNEL_VERSION;
  positioning: string;
  modules: KernelModule[];
  default_policy: KernelToolPolicy;
  domain_pack: KernelDomainPack;
};

export type KernelExportDecision = {
  allowed: boolean;
  reason: string;
  authorization: ExportAuthorization;
  policy_decision: KernelToolPolicyDecision;
};

export type KernelSkillActivationDecision = {
  active: boolean;
  reason: string;
  skill_id: string;
  approval_status: ProfessionalSkill["approval_status"];
  requires_human_approval: boolean;
};

export const DEFAULT_KERNEL_TOOL_POLICY: KernelToolPolicy = {
  can_read: true,
  can_write: true,
  can_call_model: true,
  can_use_external_model: false,
  can_export: false,
  can_modify_skill: false,
  allowed_tools: [
    "read_local_matter",
    "search_matter_documents",
    "read_source_evidence",
    "create_draft_artifact",
    "add_review_comment",
    "append_audit_event",
    "request_approval_gated_export",
    "call_local_or_deterministic_model",
  ],
  blocked_tools: [
    "call_external_model",
    "export_final",
    "modify_skill",
    "terminal",
    "browser_automation",
    "email",
    "web_search",
    "destructive_file_operation",
  ],
};

export const PRIVATE_CONTRACT_DUE_DILIGENCE_PACK: KernelDomainPack = {
  id: "private_contract_due_diligence_review",
  name: "Private Contract / Due Diligence Review",
  matter_type: "due_diligence",
  kernel_modules: [...KERNEL_MODULES],
  artifact_focus: [
    "Document",
    "DocumentChunk",
    "EvidenceItem",
    "Claim",
    "Issue",
    "Risk",
    "Obligation",
    "MemoSection",
    "ReviewComment",
    "GateResult",
    "AuditEvent",
    "AgentRun",
    "EvalCase",
    "Skill",
  ],
  gate_focus: [
    "citation",
    "human_approval",
    "missing_material",
    "conflict",
    "jurisdiction",
    "privilege",
    "external_source",
    "export",
  ],
};

export function createKernelProfile(
  overrides: {
    policy?: Partial<KernelToolPolicy>;
    domain_pack?: KernelDomainPack;
  } = {},
): KernelProfile {
  const defaultPolicy = {
    ...DEFAULT_KERNEL_TOOL_POLICY,
    ...overrides.policy,
    allowed_tools:
      overrides.policy?.allowed_tools ??
      DEFAULT_KERNEL_TOOL_POLICY.allowed_tools,
    blocked_tools:
      overrides.policy?.blocked_tools ??
      DEFAULT_KERNEL_TOOL_POLICY.blocked_tools,
  };

  return {
    version: ALETHEIA_KERNEL_VERSION,
    positioning:
      "Vera is a local-first agent harness for sensitive professional work.",
    modules: [...KERNEL_MODULES],
    default_policy: defaultPolicy,
    domain_pack: overrides.domain_pack ?? PRIVATE_CONTRACT_DUE_DILIGENCE_PACK,
  };
}

export function evaluateKernelToolPolicy(
  policy: KernelToolPolicy,
  capability: KernelToolCapability,
): KernelToolPolicyDecision {
  if (policy.blocked_tools.includes(capability)) {
    return {
      allowed: false,
      capability,
      reason: `${capability} is blocked by the kernel tool policy`,
    };
  }

  if (capability === "call_external_model" && !policy.can_use_external_model) {
    return {
      allowed: false,
      capability,
      reason: "External model calls require explicit kernel policy approval",
    };
  }

  if (
    capability === "call_local_or_deterministic_model" &&
    !policy.can_call_model
  ) {
    return {
      allowed: false,
      capability,
      reason: "Model calls are disabled for this agent policy",
    };
  }

  if (capability === "export_final" && !policy.can_export) {
    return {
      allowed: false,
      capability,
      reason: "Final export requires explicit kernel export permission",
    };
  }

  if (capability === "modify_skill" && !policy.can_modify_skill) {
    return {
      allowed: false,
      capability,
      reason: "Skill modification requires human approval and explicit policy",
    };
  }

  if (!policy.allowed_tools.includes(capability)) {
    return {
      allowed: false,
      capability,
      reason: `${capability} is not in the kernel tool allowlist`,
    };
  }

  return {
    allowed: true,
    capability,
    reason: `${capability} is allowed by the kernel tool policy`,
  };
}

export function evaluateKernelModelPolicy(params: {
  provider?: V1ModelProvider;
  model?: string;
  enabled?: boolean;
  external?: boolean;
  allowSensitiveExternal?: boolean;
  privacyMode?: V1PrivacyMode;
  policy?: KernelToolPolicy;
}): V1ProviderPolicyDecision {
  const policy = params.policy ?? DEFAULT_KERNEL_TOOL_POLICY;
  const provider = createV1ModelProviderConfig({
    provider: params.provider,
    model: params.model,
    enabled: params.enabled,
    external: params.external,
    allowSensitiveExternal:
      params.allowSensitiveExternal ?? policy.can_use_external_model,
  });
  const privacyMode = params.privacyMode ?? "private";
  const capability = provider.external
    ? "call_external_model"
    : "call_local_or_deterministic_model";
  const toolDecision = evaluateKernelToolPolicy(policy, capability);

  if (!toolDecision.allowed) {
    return {
      allowed: false,
      reason: toolDecision.reason,
      externalCall: provider.external,
      provider: provider.provider,
      model: provider.model,
      privacyMode,
    };
  }

  return evaluateV1ProviderPolicy({ provider, privacyMode });
}

export function decideKernelExport(params: {
  gateResults: GateResult[];
  intent?: ExportIntent;
  policy?: KernelToolPolicy;
}): KernelExportDecision {
  const intent = params.intent ?? "final";
  const policy = params.policy ?? DEFAULT_KERNEL_TOOL_POLICY;
  const authorization = buildExportAuthorization(params.gateResults, intent);
  const capability: KernelToolCapability =
    intent === "final" ? "export_final" : "request_approval_gated_export";
  const policyDecision = evaluateKernelToolPolicy(policy, capability);

  if (intent === "final" && !policyDecision.allowed) {
    return {
      allowed: false,
      reason: policyDecision.reason,
      authorization: {
        ...authorization,
        status: "blocked",
        final_export_allowed: false,
        validation: [
          ...authorization.validation,
          {
            name: "kernel_export_policy",
            status: "failed",
            detail: policyDecision.reason,
          },
        ],
      },
      policy_decision: policyDecision,
    };
  }

  return {
    allowed:
      intent === "final"
        ? authorization.final_export_allowed && policyDecision.allowed
        : policyDecision.allowed,
    reason:
      intent === "final"
        ? authorization.final_export_allowed
          ? "Final export is allowed by gates and kernel policy"
          : "Final export blocked by failed or missing gates"
        : "Draft export can proceed with visible gate status",
    authorization,
    policy_decision: policyDecision,
  };
}

export function decideKernelSkillActivation(params: {
  skill: ProfessionalSkill;
  approved_playbook?: {
    id: string;
    status: "draft" | "approved" | "superseded";
    approved_by?: string | null;
    approved_at?: string | null;
  };
  policy?: KernelToolPolicy;
}): KernelSkillActivationDecision {
  const policy = params.policy ?? DEFAULT_KERNEL_TOOL_POLICY;
  const playbook = params.approved_playbook;
  const hasApprovedPlaybook =
    playbook?.status === "approved" &&
    Boolean(playbook.approved_by) &&
    Boolean(playbook.approved_at);
  const canModifySkill = evaluateKernelToolPolicy(
    policy,
    "modify_skill",
  ).allowed;
  const active =
    params.skill.approval_status === "approved" &&
    Boolean(hasApprovedPlaybook) &&
    canModifySkill;

  if (active) {
    return {
      active: true,
      reason:
        "Skill has approved status, approved playbook provenance, and policy permission",
      skill_id: params.skill.id,
      approval_status: params.skill.approval_status,
      requires_human_approval: false,
    };
  }

  return {
    active: false,
    reason:
      params.skill.approval_status === "candidate"
        ? "Candidate skills are inactive until expert approval and approved playbook provenance exist"
        : !hasApprovedPlaybook
          ? "Skill activation requires approved playbook identity and timestamp"
          : "Kernel policy does not permit skill modification or activation",
    skill_id: params.skill.id,
    approval_status: params.skill.approval_status,
    requires_human_approval: true,
  };
}
