import type {
  AgentOpsMatterWorkspace,
  ArtifactRef,
  ArtifactType,
  DraftMemoSection,
} from "./types";
import type { BigAtReferenceType } from "./references";

export type MatterMemoryObject = {
  id: string;
  reference_type: BigAtReferenceType;
  title: string;
  subtitle?: string;
  matter_id?: string;
  artifact_type?: ArtifactType;
  status?: string;
  aliases: string[];
  source?: string;
  artifact_ref?: ArtifactRef;
  metadata?: Record<string, string | number | boolean | undefined>;
};

export type MatterMemoryIndex = {
  matter_id: string;
  entries: MatterMemoryObject[];
  by_id: Map<string, MatterMemoryObject>;
  by_type: Map<BigAtReferenceType, MatterMemoryObject[]>;
};

function compactAliases(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => Boolean(value && value.trim()))
        .map((value) => value.trim()),
    ),
  );
}

function artifactRef(
  type: ArtifactType,
  id: string,
  title?: string,
  hash?: string,
): ArtifactRef {
  return { id, type, title, hash };
}

function memoSectionEntry(
  matterId: string,
  memoId: string,
  section: DraftMemoSection,
): MatterMemoryObject {
  return {
    id: section.id,
    reference_type: "Memo",
    title: section.title,
    subtitle: `Section in ${memoId}`,
    matter_id: matterId,
    artifact_type: "draft_memo",
    aliases: compactAliases([section.id, section.title, `Memo:${section.id}`]),
    artifact_ref: artifactRef("draft_memo", section.id, section.title),
    metadata: {
      memo_id: memoId,
      unsupported_claim_count: section.unsupported_claim_count ?? 0,
    },
  };
}

function clauseEntryFromEvidence(
  evidence: AgentOpsMatterWorkspace["evidence"][number],
): MatterMemoryObject | undefined {
  if (!evidence.source_chunk_id && !evidence.section) {
    return undefined;
  }

  const clauseId = evidence.source_chunk_id ?? `${evidence.source_document_id}:${evidence.id}`;
  const title = evidence.section ?? `Clause from ${evidence.source_document_id}`;

  return {
    id: clauseId,
    reference_type: "Clause",
    title,
    subtitle: evidence.quote.replace(/\s+/g, " ").trim().slice(0, 160),
    matter_id: evidence.matter_id,
    artifact_type: "evidence_item",
    status: evidence.review_status,
    aliases: compactAliases([
      clauseId,
      evidence.id,
      evidence.section,
      evidence.source_chunk_id,
      evidence.source_document_id,
      evidence.normalized_fact,
    ]),
    artifact_ref: artifactRef("evidence_item", evidence.id, title),
    metadata: {
      evidence_id: evidence.id,
      source_document_id: evidence.source_document_id,
      source_chunk_id: evidence.source_chunk_id,
      quote_start: evidence.quote_start,
      quote_end: evidence.quote_end,
      page: evidence.page,
    },
  };
}

export function createMatterMemoryEntries(
  workspace: AgentOpsMatterWorkspace,
  additionalEntries: MatterMemoryObject[] = [],
): MatterMemoryObject[] {
  const { matter } = workspace;
  const entries: MatterMemoryObject[] = [
    {
      id: matter.id,
      reference_type: "Matter",
      title: matter.title,
      subtitle: `${matter.type} / ${matter.risk_level} risk`,
      matter_id: matter.id,
      artifact_type: "matter",
      status: matter.status,
      aliases: compactAliases([matter.id, matter.title, "Matter"]),
      artifact_ref: artifactRef("matter", matter.id, matter.title),
      metadata: { type: matter.type, risk_level: matter.risk_level },
    },
    ...matter.documents.map((document) => ({
      id: document.id,
      reference_type: "Document" as const,
      title: document.title,
      subtitle: document.filename,
      matter_id: matter.id,
      artifact_type: "document" as const,
      status: document.status,
      aliases: compactAliases([
        document.id,
        document.title,
        document.filename,
        document.source_uri,
      ]),
      source: document.source_uri,
      artifact_ref: artifactRef("document", document.id, document.title, document.hash),
      metadata: { document_type: document.document_type },
    })),
    ...workspace.evidence.map((evidence) => ({
      id: evidence.id,
      reference_type: "Evidence" as const,
      title: evidence.normalized_fact,
      subtitle: evidence.section ?? evidence.source_document_id,
      matter_id: evidence.matter_id,
      artifact_type: "evidence_item" as const,
      status: evidence.review_status,
      aliases: compactAliases([evidence.id, evidence.normalized_fact, evidence.section]),
      artifact_ref: artifactRef(
        "evidence_item",
        evidence.id,
        evidence.normalized_fact,
      ),
      metadata: {
        source_document_id: evidence.source_document_id,
        confidence: evidence.confidence,
        page: evidence.page,
      },
    })),
    ...workspace.evidence
      .map(clauseEntryFromEvidence)
      .filter((entry): entry is MatterMemoryObject => Boolean(entry)),
    ...workspace.issues.map((issue) => ({
      id: issue.id,
      reference_type: "Issue" as const,
      title: issue.title,
      subtitle: issue.legal_or_professional_standard,
      matter_id: issue.matter_id,
      artifact_type: "issue_node" as const,
      status: issue.review_status,
      aliases: compactAliases([issue.id, issue.title]),
      artifact_ref: artifactRef("issue_node", issue.id, issue.title),
      metadata: { risk_level: issue.risk_level },
    })),
    ...workspace.risks.map((risk) => ({
      id: risk.id,
      reference_type: "Risk" as const,
      title: risk.title,
      subtitle: risk.recommendation,
      matter_id: risk.matter_id,
      artifact_type: "risk_item" as const,
      status: risk.status,
      aliases: compactAliases([risk.id, risk.title]),
      artifact_ref: artifactRef("risk_item", risk.id, risk.title),
      metadata: { severity: risk.severity, likelihood: risk.likelihood },
    })),
    ...workspace.draft_memos.flatMap((memo) => [
      {
        id: memo.id,
        reference_type: "Memo" as const,
        title: memo.title,
        subtitle: `${memo.sections.length} sections`,
        matter_id: memo.matter_id,
        artifact_type: "draft_memo" as const,
        status: memo.review_status,
        aliases: compactAliases([memo.id, memo.title]),
        artifact_ref: artifactRef("draft_memo", memo.id, memo.title),
        metadata: {
          citation_coverage_score: memo.citation_coverage_score,
          unsupported_claim_count: memo.unsupported_claim_count,
        },
      },
      ...memo.sections.map((section) => memoSectionEntry(memo.matter_id, memo.id, section)),
    ]),
    ...workspace.review_comments.map((comment) => ({
      id: comment.id,
      reference_type: "ReviewComment" as const,
      title: comment.comment,
      subtitle: `${comment.author} / ${comment.severity}`,
      matter_id: comment.matter_id,
      artifact_type: "review_comment" as const,
      status: comment.status,
      aliases: compactAliases([comment.id, comment.comment]),
      artifact_ref: artifactRef("review_comment", comment.id, comment.comment),
      metadata: {
        artifact_id: comment.artifact_id,
        artifact_type: comment.artifact_type,
      },
    })),
    ...workspace.gate_results.map((gate) => ({
      id: gate.id,
      reference_type: "Gate" as const,
      title: gate.reason,
      subtitle: gate.gate_type,
      matter_id: gate.matter_id,
      artifact_type: "gate_result" as const,
      status: gate.status,
      aliases: compactAliases([gate.id, gate.gate_type, gate.reason]),
      artifact_ref: artifactRef("gate_result", gate.id, gate.gate_type),
      metadata: { gate_type: gate.gate_type },
    })),
    ...workspace.runs.map((run) => ({
      id: run.id,
      reference_type: "Run" as const,
      title: run.id,
      subtitle: `${run.agent_id} / ${run.status}`,
      matter_id: run.matter_id,
      artifact_type: "agent_run" as const,
      status: run.status,
      aliases: compactAliases([run.id, run.agent_id]),
      artifact_ref: artifactRef("agent_run", run.id, run.agent_id),
      metadata: { agent_id: run.agent_id, model: run.model },
    })),
    ...workspace.skills.map((skill) => ({
      id: skill.id,
      reference_type: "Skill" as const,
      title: skill.name,
      subtitle: skill.description,
      artifact_type: "professional_skill" as const,
      status: skill.approval_status,
      aliases: compactAliases([skill.id, skill.name, ...skill.trigger_conditions]),
      artifact_ref: artifactRef("professional_skill", skill.id, skill.name),
      metadata: { version: skill.version },
    })),
    ...workspace.eval_cases.map((evalCase) => ({
      id: evalCase.id,
      reference_type: "EvalCase" as const,
      title: evalCase.expected_behavior,
      subtitle: evalCase.failure_type,
      matter_id: evalCase.matter_id,
      artifact_type: "eval_case" as const,
      status: evalCase.status,
      aliases: compactAliases([evalCase.id, evalCase.failure_type, evalCase.expected_behavior]),
      artifact_ref: artifactRef("eval_case", evalCase.id, evalCase.failure_type),
      metadata: { source_run_id: evalCase.source_run_id },
    })),
    ...additionalEntries,
  ];

  return entries;
}

export function createMatterMemoryIndex(
  workspace: AgentOpsMatterWorkspace,
  additionalEntries: MatterMemoryObject[] = [],
): MatterMemoryIndex {
  const entries = createMatterMemoryEntries(workspace, additionalEntries);
  const by_id = new Map<string, MatterMemoryObject>();
  const by_type = new Map<BigAtReferenceType, MatterMemoryObject[]>();

  for (const entry of entries) {
    by_id.set(entry.id, entry);
    const typedEntries = by_type.get(entry.reference_type) ?? [];
    typedEntries.push(entry);
    by_type.set(entry.reference_type, typedEntries);
  }

  return {
    matter_id: workspace.matter.id,
    entries,
    by_id,
    by_type,
  };
}
