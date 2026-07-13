import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createKernelProfile,
  decideKernelExport,
  decideKernelSkillActivation,
  DEFAULT_KERNEL_TOOL_POLICY,
  evaluateKernelModelPolicy,
  evaluateKernelToolPolicy,
  KERNEL_MODULES,
  PRIVATE_CONTRACT_DUE_DILIGENCE_PACK,
  type KernelToolPolicy,
} from "../../src/aletheia/agentops/kernel";
import type { GateResult, ProfessionalSkill } from "../../src/aletheia/agentops/types";

const now = "2026-07-09T10:30:00.000Z";

function gate(
  gate_type: GateResult["gate_type"],
  status: GateResult["status"],
): GateResult {
  return {
    id: `gate-kernel-${gate_type}`,
    matter_id: "matter-kernel",
    gate_type,
    status,
    reason: `${gate_type} ${status}`,
    affected_artifact_ids: ["memo-kernel"],
    created_at: now,
  };
}

const passingFinalGates = [
  gate("citation", "passed"),
  gate("human_approval", "passed"),
  gate("missing_material", "passed"),
  gate("conflict", "passed"),
  gate("jurisdiction", "passed"),
  gate("privilege", "passed"),
  gate("external_source", "passed"),
  gate("export", "passed"),
] satisfies GateResult[];

const exportCapablePolicy: KernelToolPolicy = {
  ...DEFAULT_KERNEL_TOOL_POLICY,
  can_export: true,
  allowed_tools: [
    ...DEFAULT_KERNEL_TOOL_POLICY.allowed_tools,
    "export_final",
    "modify_skill",
  ],
  blocked_tools: DEFAULT_KERNEL_TOOL_POLICY.blocked_tools.filter(
    (tool) => tool !== "export_final" && tool !== "modify_skill",
  ),
  can_modify_skill: true,
};

test("kernel profile exposes reusable modules with contract review as a domain pack", () => {
  const profile = createKernelProfile();

  assert.equal(profile.positioning, "Vera is a local-first agent harness for sensitive professional work.");
  assert.deepEqual(profile.modules, [...KERNEL_MODULES]);
  assert.equal(profile.domain_pack.id, "private_contract_due_diligence_review");
  assert.equal(profile.domain_pack.name, "Private Contract / Due Diligence Review");
  assert.deepEqual(profile.domain_pack.kernel_modules, [...KERNEL_MODULES]);
  assert.equal(
    PRIVATE_CONTRACT_DUE_DILIGENCE_PACK.artifact_focus.includes("AgentRun"),
    true,
  );
});

test("default kernel policy is local-first and blocks risky tools", () => {
  assert.equal(
    evaluateKernelToolPolicy(DEFAULT_KERNEL_TOOL_POLICY, "read_local_matter")
      .allowed,
    true,
  );
  assert.equal(
    evaluateKernelToolPolicy(DEFAULT_KERNEL_TOOL_POLICY, "terminal").allowed,
    false,
  );
  assert.equal(
    evaluateKernelToolPolicy(DEFAULT_KERNEL_TOOL_POLICY, "browser_automation")
      .allowed,
    false,
  );
  assert.equal(
    evaluateKernelToolPolicy(DEFAULT_KERNEL_TOOL_POLICY, "email").allowed,
    false,
  );
  assert.equal(
    evaluateKernelToolPolicy(DEFAULT_KERNEL_TOOL_POLICY, "destructive_file_operation")
      .allowed,
    false,
  );
  assert.equal(
    evaluateKernelToolPolicy(DEFAULT_KERNEL_TOOL_POLICY, "call_external_model")
      .allowed,
    false,
  );
});

test("kernel model policy permits deterministic mode and fails closed for sensitive external calls", () => {
  const deterministic = evaluateKernelModelPolicy({
    provider: "deterministic",
    privacyMode: "sensitive",
  });
  const external = evaluateKernelModelPolicy({
    provider: "openai",
    model: "gpt-configured",
    enabled: true,
    privacyMode: "sensitive",
  });

  assert.equal(deterministic.allowed, true);
  assert.equal(deterministic.externalCall, false);
  assert.equal(external.allowed, false);
  assert.equal(external.externalCall, true);
  assert.match(external.reason, /call_external_model is blocked/);
});

test("kernel export decision requires both passing gates and explicit final export permission", () => {
  const defaultDecision = decideKernelExport({
    gateResults: passingFinalGates,
    intent: "final",
  });
  assert.equal(defaultDecision.allowed, false);
  assert.equal(defaultDecision.authorization.status, "blocked");
  assert.equal(defaultDecision.authorization.final_export_allowed, false);
  assert.equal(
    defaultDecision.authorization.validation.some(
      (item) => item.name === "kernel_export_policy" && item.status === "failed",
    ),
    true,
  );

  const authorizedDecision = decideKernelExport({
    gateResults: passingFinalGates,
    intent: "final",
    policy: exportCapablePolicy,
  });
  assert.equal(authorizedDecision.allowed, true);
  assert.equal(authorizedDecision.authorization.status, "authorized");

  const failedGateDecision = decideKernelExport({
    gateResults: [
      ...passingFinalGates.filter((item) => item.gate_type !== "citation"),
      gate("citation", "failed"),
    ],
    intent: "final",
    policy: exportCapablePolicy,
  });
  assert.equal(failedGateDecision.allowed, false);
  assert.equal(failedGateDecision.authorization.status, "blocked");
  assert.match(failedGateDecision.reason, /blocked by failed or missing gates/);
});

test("kernel skill activation requires approved skill, approved playbook, and policy permission", () => {
  const skill = {
    id: "skill-kernel-candidate",
    name: "Kernel Candidate Skill",
    description: "Candidate only.",
    trigger_conditions: ["failure_type == missing_citation"],
    required_inputs: ["eval_case"],
    expected_outputs: ["review_comment"],
    evidence_requirements: ["Preserve source eval case IDs."],
    approval_status: "candidate",
    created_from_eval_case_ids: ["eval-kernel"],
    version: "0.1.0",
  } satisfies ProfessionalSkill;

  const candidateDecision = decideKernelSkillActivation({
    skill,
    policy: exportCapablePolicy,
  });
  assert.equal(candidateDecision.active, false);
  assert.equal(candidateDecision.requires_human_approval, true);

  const approvedDecision = decideKernelSkillActivation({
    skill: { ...skill, approval_status: "approved", version: "1.0.0" },
    approved_playbook: {
      id: "playbook-kernel-approved",
      status: "approved",
      approved_by: "expert-reviewer",
      approved_at: now,
    },
    policy: exportCapablePolicy,
  });
  assert.equal(approvedDecision.active, true);
  assert.equal(approvedDecision.requires_human_approval, false);
});
