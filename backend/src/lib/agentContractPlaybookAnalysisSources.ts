import { z } from "zod";

import type { ContractPlaybookContextV1 } from "./agent-packs/contract/contractPlaybookContext";
import {
  contractPlaybookAnalysisOutputSchema,
  ContractPlaybookStructuredOutputError,
} from "./agent-packs/contract/contractPlaybookPack";
import { extractDocxBodyText } from "./docxTrackedChanges";
import { downloadFile } from "./storage";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type ContractPlaybookAnalysisSources = {
  contractText: string;
  referenceText: string;
};

const MAX_FIXED_SOURCE_CHARS = 120_000;

export async function loadContractPlaybookAnalysisSources(input: {
  db: Db;
  context: ContractPlaybookContextV1;
  matterId: string;
  userId: string;
}): Promise<ContractPlaybookAnalysisSources> {
  const documentIds = [
    input.context.contract.document_id,
    input.context.reference.document_id,
  ];
  const versionIds = [
    input.context.contract.version_id,
    input.context.reference.version_id,
  ];
  const [{ data: documents, error: documentError }, { data: versions, error }] =
    await Promise.all([
      input.db
        .from("documents")
        .select("id")
        .in("id", documentIds)
        .eq("project_id", input.matterId)
        .eq("user_id", input.userId),
      input.db
        .from("document_versions")
        .select("id,document_id,storage_path,file_type,deleted_at")
        .in("id", versionIds),
    ]);
  if (documentError) throw new Error(documentError.message);
  if (error) throw new Error(error.message);
  if (new Set((documents ?? []).map((row) => row.id)).size !== 2) {
    throw new ContractPlaybookStructuredOutputError(
      "The fixed Contract Playbook sources are outside the current Matter",
    );
  }
  const versionById = new Map(
    (versions ?? []).map((version) => [version.id as string, version]),
  );

  const read = async (binding: { document_id: string; version_id: string }) => {
    const version = versionById.get(binding.version_id);
    if (
      !version ||
      version.document_id !== binding.document_id ||
      version.deleted_at ||
      typeof version.storage_path !== "string" ||
      version.file_type?.toLowerCase() !== "docx"
    ) {
      throw new ContractPlaybookStructuredOutputError(
        "A fixed Contract Playbook Version is unavailable or no longer matches its Document",
      );
    }
    const raw = await downloadFile(version.storage_path);
    if (!raw) {
      throw new ContractPlaybookStructuredOutputError(
        "A fixed Contract Playbook Version could not be read",
      );
    }
    const text = await extractDocxBodyText(Buffer.from(raw));
    if (!text.trim() || text.length > MAX_FIXED_SOURCE_CHARS) {
      throw new ContractPlaybookStructuredOutputError(
        "A fixed Contract Playbook source is empty or exceeds the bounded analysis scope",
      );
    }
    return text;
  };

  const [contractText, referenceText] = await Promise.all([
    read(input.context.contract),
    read(input.context.reference),
  ]);
  return { contractText, referenceText };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactRuleBlock(input: {
  referenceText: string;
  ruleId: string;
  ruleVersion: string;
}) {
  const header = `${input.ruleId}@${input.ruleVersion}`;
  const pattern = new RegExp(`(^|\\n)${escapeRegExp(header)}(?:\\s|·|$)`, "gu");
  const matches = [...input.referenceText.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new ContractPlaybookStructuredOutputError(
      `The fixed Playbook rule ${header} could not be uniquely relocated`,
    );
  }
  const start = matches[0]!.index! + (matches[0]![1]?.length ?? 0);
  const tail = input.referenceText.slice(start);
  const nextHeader = tail
    .slice(header.length)
    .search(
      /\n[A-Za-z0-9][A-Za-z0-9._:-]{0,119}@[A-Za-z0-9][A-Za-z0-9._:-]{0,119}(?:\s|·|$)/u,
    );
  const end =
    nextHeader < 0
      ? input.referenceText.length
      : start + header.length + nextHeader;
  const block = input.referenceText.slice(start, end).trim();
  if (!block || !input.referenceText.includes(block)) {
    throw new ContractPlaybookStructuredOutputError(
      `The fixed Playbook rule ${header} has no exact source block`,
    );
  }
  return block;
}

function parseSingleJsonObject(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Continue with a mechanically bounded extraction. Provider prose may
    // surround one JSON object, but two parseable objects remain ambiguous.
  }

  const candidates: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      candidates.push(JSON.parse(text.slice(start, index + 1)));
    } catch {
      // A brace-delimited prose fragment is not a JSON candidate.
    }
    start = -1;
  }
  const contractCandidates = candidates.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as { kind?: unknown }).kind ===
        "contract_playbook_analysis_v1" &&
      Array.isArray((candidate as { findings?: unknown }).findings),
  );
  if (contractCandidates.length !== 1) {
    throw new ContractPlaybookStructuredOutputError(
      "Contract analysis does not contain one unambiguous contract_playbook_analysis_v1 object",
    );
  }
  return contractCandidates[0];
}

const candidateSchema = z
  .object({
    kind: z.literal("contract_playbook_analysis_v1"),
    findings: z.array(z.record(z.unknown())).max(80),
  })
  .strict();

const candidateIdentitySchema = z
  .object({
    rule_id: z.string().trim().min(1).max(120),
    rule_version: z.string().trim().min(1).max(120),
    contract_quote: z.string().trim().min(1).max(4_000).nullable(),
  })
  .passthrough();

function zodIssueSummary(error: z.ZodError) {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function mechanicallyNormalizedConfidence(value: unknown) {
  if (typeof value === "number" || value === null) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(trimmed)) return null;
  return Number(trimmed);
}

function mechanicallyNormalizedBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function fixedIssueType(ruleId: string) {
  return ruleId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function bindContractPlaybookAnalysisToFixedSources(input: {
  rawOutput: string;
  context: ContractPlaybookContextV1;
  sources: ContractPlaybookAnalysisSources;
}) {
  let decoded: unknown;
  try {
    decoded = parseSingleJsonObject(input.rawOutput);
  } catch (error) {
    if (error instanceof ContractPlaybookStructuredOutputError) throw error;
    throw new ContractPlaybookStructuredOutputError(
      "Contract analysis is not one parseable JSON object",
    );
  }
  const candidate = candidateSchema.safeParse(decoded);
  if (!candidate.success) {
    throw new ContractPlaybookStructuredOutputError(
      `Contract analysis envelope is invalid: ${zodIssueSummary(candidate.error)}`,
    );
  }

  const citations: Array<Record<string, unknown>> = [];
  const findings = candidate.data.findings.map((finding) => {
    const identity = candidateIdentitySchema.safeParse(finding);
    if (!identity.success) {
      throw new ContractPlaybookStructuredOutputError(
        `Contract finding identity is invalid: ${zodIssueSummary(identity.error)}`,
      );
    }
    const contractRefs: number[] = [];
    if (identity.data.contract_quote !== null) {
      if (!input.sources.contractText.includes(identity.data.contract_quote)) {
        throw new ContractPlaybookStructuredOutputError(
          `The contract quote for ${identity.data.rule_id} is not one continuous exact substring of the fixed contract Version`,
        );
      }
      const ref = citations.length + 1;
      contractRefs.push(ref);
      citations.push({
        kind: "document",
        ref,
        document_id: input.context.contract.document_id,
        version_id: input.context.contract.version_id,
        quote: identity.data.contract_quote,
        quotes: [{ quote: identity.data.contract_quote }],
      });
    }

    const playbookQuote = exactRuleBlock({
      referenceText: input.sources.referenceText,
      ruleId: identity.data.rule_id,
      ruleVersion: identity.data.rule_version,
    });
    const playbookRef = citations.length + 1;
    citations.push({
      kind: "document",
      ref: playbookRef,
      document_id: input.context.reference.document_id,
      version_id: input.context.reference.version_id,
      quote: playbookQuote,
      quotes: [{ quote: playbookQuote }],
    });
    return {
      ...finding,
      material: mechanicallyNormalizedBoolean(finding.material),
      // rule_id is already fixed by the server-owned Playbook. Bind the
      // redundant machine issue code to that identity instead of letting
      // provider wording affect persistence or finding identity.
      issue_type: fixedIssueType(identity.data.rule_id),
      confidence: mechanicallyNormalizedConfidence(finding.confidence),
      contract_citation_refs: contractRefs,
      playbook_citation_refs: [playbookRef],
    };
  });

  const normalized = contractPlaybookAnalysisOutputSchema.safeParse({
    kind: candidate.data.kind,
    findings,
  });
  if (!normalized.success) {
    throw new ContractPlaybookStructuredOutputError(
      `Contract findings violate the fixed schema: ${zodIssueSummary(normalized.error)}`,
    );
  }
  return {
    rawOutput: JSON.stringify(normalized.data),
    citations,
  };
}
