import { computeArtifactId } from "../../aletheia/agentops/schemas";
import type {
  ArtifactType,
  EvalCase,
  EvalFailureType,
  GateResult,
  ProfessionalSkill,
  ReviewComment,
} from "../../aletheia/agentops/types";

export type SkillFeedbackSource = {
  eval_cases: EvalCase[];
  review_comments?: ReviewComment[];
  gate_results?: GateResult[];
};

export type SkillCandidateOptions = {
  min_occurrences?: number;
  matter_id?: string;
};

export type SkillPlaybookApprovalRecord = {
  id: string;
  status: "draft" | "approved" | "superseded";
  approved_by: string | null;
  approved_at: string | null;
  content?: Record<string, unknown>;
};

export type SkillPlaybookApprovalState = {
  skill_id: string;
  skill_name: string;
  approval_status: ProfessionalSkill["approval_status"];
  playbook_id?: string;
  playbook_status?: SkillPlaybookApprovalRecord["status"];
  active: boolean;
  requires_human_approval: boolean;
  warnings: string[];
};

type SkillPattern = {
  key: EvalFailureType;
  name: string;
  description: string;
  trigger_conditions: string[];
  required_inputs: ArtifactType[];
  expected_outputs: ArtifactType[];
  evidence_requirements: string[];
};

const skillPatterns: Record<EvalFailureType, SkillPattern> = {
  unsupported_claim: {
    key: "unsupported_claim",
    name: "Unsupported claim evidence check",
    description:
      "Flag material assertions that lack linked evidence before a professional memo can advance.",
    trigger_conditions: [
      "artifact_type == draft_memo",
      "section.unsupported_claim_count > 0",
    ],
    required_inputs: ["draft_memo", "evidence_item", "review_comment"],
    expected_outputs: ["gate_result", "review_comment"],
    evidence_requirements: [
      "Every material factual assertion must link to a source quote or be rewritten as an open question.",
    ],
  },
  missing_citation: {
    key: "missing_citation",
    name: "Missing citation remediation gate",
    description:
      "Require source references for memo sections or explicit open-item labeling when evidence is unavailable.",
    trigger_conditions: [
      "artifact_type == draft_memo",
      "section.evidence_reference_ids is empty",
    ],
    required_inputs: ["draft_memo", "evidence_item", "gate_result"],
    expected_outputs: ["gate_result", "review_comment"],
    evidence_requirements: [
      "Each cited conclusion must include evidence IDs, or the section must state the missing material needed.",
    ],
  },
  missed_issue: {
    key: "missed_issue",
    name: "Missed issue coverage check",
    description:
      "Compare expert feedback against the issue map and create follow-up issue nodes for material omissions.",
    trigger_conditions: [
      "review_comment.status == open",
      "failure_type == missed_issue",
    ],
    required_inputs: ["issue_node", "review_comment", "evidence_item"],
    expected_outputs: ["issue_node", "gate_result"],
    evidence_requirements: [
      "New issue nodes must cite the feedback source and any evidence that makes the issue material.",
    ],
  },
  wrong_risk_level: {
    key: "wrong_risk_level",
    name: "Risk level override review",
    description:
      "Route expert risk-level overrides into a visible risk recalibration gate instead of silently changing severity.",
    trigger_conditions: [
      "failure_type == wrong_risk_level",
      "review_comment.severity in high,medium",
    ],
    required_inputs: ["risk_item", "review_comment", "evidence_item"],
    expected_outputs: ["risk_item", "gate_result"],
    evidence_requirements: [
      "Risk changes must reference the expert override and the evidence or missing material that supports it.",
    ],
  },
  contradiction_missed: {
    key: "contradiction_missed",
    name: "Contradiction review gate",
    description:
      "Detect conflicting source-backed statements and require reviewer disposition before export.",
    trigger_conditions: [
      "failure_type == contradiction_missed",
      "matter.risk_level in high,medium",
    ],
    required_inputs: ["evidence_item", "draft_memo", "review_comment"],
    expected_outputs: ["gate_result", "review_comment"],
    evidence_requirements: [
      "Contradictions must list both evidence IDs and the reviewer decision that resolves or preserves the conflict.",
    ],
  },
  bad_memo_structure: {
    key: "bad_memo_structure",
    name: "Professional memo structure check",
    description:
      "Check that work products preserve required sections for standard, evidence analysis, risks, and open items.",
    trigger_conditions: [
      "artifact_type == draft_memo",
      "failure_type == bad_memo_structure",
    ],
    required_inputs: ["draft_memo", "review_comment"],
    expected_outputs: ["review_comment", "gate_result"],
    evidence_requirements: [
      "Structural revisions must preserve citation and issue references already attached to memo sections.",
    ],
  },
  expert_override: {
    key: "expert_override",
    name: "Expert override audit trail",
    description:
      "Capture expert overrides as auditable feedback that can propose a playbook update only after approval.",
    trigger_conditions: [
      "failure_type == expert_override",
      "author is expert reviewer",
    ],
    required_inputs: ["review_comment", "audit_event"],
    expected_outputs: ["eval_case", "professional_skill"],
    evidence_requirements: [
      "The override must preserve reviewer identity, affected artifact ID, rationale, and approval state.",
    ],
  },
};

function classifyComment(comment: ReviewComment): EvalFailureType | null {
  const text = comment.comment.toLowerCase();

  if (text.includes("citation") || text.includes("source")) {
    return "missing_citation";
  }
  if (text.includes("unsupported")) {
    return "unsupported_claim";
  }
  if (text.includes("risk level") || text.includes("severity")) {
    return "wrong_risk_level";
  }
  if (text.includes("contradiction") || text.includes("conflict")) {
    return "contradiction_missed";
  }
  if (text.includes("structure") || text.includes("section")) {
    return "bad_memo_structure";
  }

  return null;
}

function classifyGate(gate: GateResult): EvalFailureType | null {
  if (gate.gate_type === "citation") return "missing_citation";
  if (gate.gate_type === "conflict") return "contradiction_missed";
  if (gate.gate_type === "human_approval" && gate.status === "failed") {
    return "expert_override";
  }
  return null;
}

export function suggestProfessionalSkillCandidates(
  feedback: SkillFeedbackSource,
  options: SkillCandidateOptions = {},
): ProfessionalSkill[] {
  const minOccurrences = options.min_occurrences ?? 2;
  const grouped = new Map<
    EvalFailureType,
    { evalCaseIds: Set<string>; occurrenceCount: number }
  >();

  function addOccurrence(key: EvalFailureType, evalCaseId?: string) {
    const current =
      grouped.get(key) ?? { evalCaseIds: new Set<string>(), occurrenceCount: 0 };
    current.occurrenceCount += 1;
    if (evalCaseId) current.evalCaseIds.add(evalCaseId);
    grouped.set(key, current);
  }

  for (const evalCase of feedback.eval_cases) {
    addOccurrence(evalCase.failure_type, evalCase.id);
  }

  for (const comment of feedback.review_comments ?? []) {
    const key = classifyComment(comment);
    if (key) addOccurrence(key);
  }

  for (const gate of feedback.gate_results ?? []) {
    const key = classifyGate(gate);
    if (key) addOccurrence(key);
  }

  return [...grouped.entries()]
    .filter(([, group]) => group.occurrenceCount >= minOccurrences)
    .map(([key, group]) => {
      const pattern = skillPatterns[key];
      const evalCaseIds = [...group.evalCaseIds].sort();
      const seed = `${pattern.key}:${evalCaseIds.join(",")}:${group.occurrenceCount}`;
      const matterId = options.matter_id ?? "professional-skills-loop";

      return {
        id: computeArtifactId("professional_skill", matterId, seed),
        name: pattern.name,
        description: pattern.description,
        trigger_conditions: pattern.trigger_conditions,
        required_inputs: pattern.required_inputs,
        expected_outputs: pattern.expected_outputs,
        evidence_requirements: pattern.evidence_requirements,
        approval_status: "candidate",
        created_from_eval_case_ids: evalCaseIds,
        version: "0.1.0",
      };
    });
}

function playbookMatchesSkill(
  playbook: SkillPlaybookApprovalRecord,
  skill: ProfessionalSkill,
) {
  return (
    playbook.id === skill.id ||
    playbook.content?.professionalSkillId === skill.id ||
    playbook.content?.skillId === skill.id
  );
}

export function mapSkillsToPlaybookApprovalState(
  skills: ProfessionalSkill[],
  playbooks: SkillPlaybookApprovalRecord[] = [],
): SkillPlaybookApprovalState[] {
  return skills.map((skill) => {
    const playbook = playbooks.find((item) => playbookMatchesSkill(item, skill));
    const hasApprovedPlaybook =
      playbook?.status === "approved" &&
      Boolean(playbook.approved_by) &&
      Boolean(playbook.approved_at);
    const active = skill.approval_status === "approved" && hasApprovedPlaybook;
    const warnings: string[] = [];

    if (skill.approval_status === "candidate") {
      warnings.push(
        "Candidate skills are inactive until a human-approved matter playbook exists.",
      );
    }

    if (skill.approval_status === "approved" && !playbook) {
      warnings.push(
        "Approved skill is not backed by a persisted approved playbook record.",
      );
    }

    if (playbook && playbook.status !== "approved") {
      warnings.push("Mapped playbook is not approved.");
    }

    if (
      playbook?.status === "approved" &&
      (!playbook.approved_by || !playbook.approved_at)
    ) {
      warnings.push("Approved playbook lacks approval identity or timestamp.");
    }

    return {
      skill_id: skill.id,
      skill_name: skill.name,
      approval_status: skill.approval_status,
      playbook_id: playbook?.id,
      playbook_status: playbook?.status,
      active,
      requires_human_approval: !active,
      warnings,
    };
  });
}
