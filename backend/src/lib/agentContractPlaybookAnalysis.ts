import { z } from "zod";

import type { ContractPlaybookContextV1 } from "./agent-packs/contract/contractPlaybookContext";
import {
  compileContractPlaybookReceipt,
  ContractPlaybookStructuredOutputError,
  parseContractPlaybookAnalysisOutput,
} from "./agent-packs/contract/contractPlaybookPack";

const citationSchema = z
  .object({
    kind: z.literal("document"),
    ref: z.number().int().positive().max(10_000),
    document_id: z.string().uuid(),
    version_id: z.string().uuid(),
    quote: z.string().trim().min(1).max(10_000),
    quotes: z
      .array(
        z.object({ quote: z.string().trim().min(1).max(10_000) }).passthrough(),
      )
      .min(1)
      .max(3),
  })
  .passthrough();

function normalizedQuote(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function compileContractPlaybookAnalysisReceipt(input: {
  context: ContractPlaybookContextV1;
  rawOutput: string;
  citations: unknown[];
  analyzeStepId: string;
  analyzeAttempt: number;
  citationSnapshotArtifactId: string;
}) {
  const analysis = parseContractPlaybookAnalysisOutput(input.rawOutput);
  const citations = z.array(citationSchema).max(160).safeParse(input.citations);
  if (!citations.success) {
    throw new ContractPlaybookStructuredOutputError(
      "Contract analysis citations are malformed",
    );
  }
  const citationByRef = new Map(
    citations.data.map((citation) => [citation.ref, citation]),
  );
  const refs = citations.data.map((citation) => citation.ref);
  if (
    citationByRef.size !== citations.data.length ||
    refs.some((ref, index) => ref !== index + 1)
  ) {
    throw new ContractPlaybookStructuredOutputError(
      "Contract analysis citation refs must be unique and contiguous",
    );
  }
  const usedRefs = new Set<number>();
  for (const finding of analysis.findings) {
    for (const ref of finding.contract_citation_refs) {
      usedRefs.add(ref);
      const citation = citationByRef.get(ref);
      if (
        !citation ||
        citation.document_id !== input.context.contract.document_id ||
        citation.version_id !== input.context.contract.version_id
      ) {
        throw new ContractPlaybookStructuredOutputError(
          `Contract citation ${ref} is not bound to the fixed contract Version`,
        );
      }
      if (
        finding.contract_quote === null ||
        !citation.quotes.some(
          (quote) =>
            normalizedQuote(quote.quote) ===
            normalizedQuote(finding.contract_quote!),
        )
      ) {
        throw new ContractPlaybookStructuredOutputError(
          `Contract citation ${ref} does not prove the finding's exact quote`,
        );
      }
    }
    for (const ref of finding.playbook_citation_refs) {
      usedRefs.add(ref);
      const citation = citationByRef.get(ref);
      if (
        !citation ||
        citation.document_id !== input.context.reference.document_id ||
        citation.version_id !== input.context.reference.version_id
      ) {
        throw new ContractPlaybookStructuredOutputError(
          `Reference citation ${ref} is not bound to the fixed reference Version`,
        );
      }
    }
  }
  if (
    citations.data.some((citation) => !usedRefs.has(citation.ref)) ||
    usedRefs.size !== citations.data.length
  ) {
    throw new ContractPlaybookStructuredOutputError(
      "Every Contract analysis citation must be used by one fixed finding",
    );
  }
  return compileContractPlaybookReceipt({
    reviewMode: input.context.review.mode,
    opinionLanguage: input.context.review.language,
    analyzeStepId: input.analyzeStepId,
    analyzeAttempt: input.analyzeAttempt,
    contract: {
      document_id: input.context.contract.document_id,
      version_id: input.context.contract.version_id,
    },
    reference: {
      role: input.context.reference.role,
      document_id: input.context.reference.document_id,
      version_id: input.context.reference.version_id,
      rule_set_digest: input.context.reference.rule_set_digest,
      expected_rule_count: input.context.reference.expected_rule_count,
      expected_rules: input.context.reference.expected_rules,
    },
    citationSnapshotArtifactId: input.citationSnapshotArtifactId,
    findings: analysis.findings,
  });
}
