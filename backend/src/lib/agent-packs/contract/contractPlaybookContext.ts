import { z } from "zod";

import type { MatterContextManifestV1 } from "../../agent-kernel/context/matterContext";

export const CONTRACT_PLAYBOOK_WORKFLOW_ID =
  "builtin-contract-playbook-review" as const;
export const CONTRACT_PLAYBOOK_CONTEXT_VERSION = "1.0.0" as const;

const bounded = (maximum: number) => z.string().trim().min(1).max(maximum);

export const contractPlaybookContextInputSchema = z
  .object({
    contract_document_id: z.string().uuid(),
    reference_document_id: z.string().uuid(),
    reference_role: z.enum(["playbook", "baseline"]),
    review_mode: z.enum(["quick", "deep", "checklist", "compare"]),
    contract_type: bounded(120),
    represented_side: bounded(120),
    negotiation_posture: z.enum(["assertive", "balanced", "protective"]),
    jurisdiction: bounded(200),
    language: z.enum(["auto", "zh", "en", "bilingual"]),
    background_facts: bounded(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contract_document_id === value.reference_document_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference_document_id"],
        message: "The contract and reference must be distinct",
      });
    }
    const expectedRole =
      value.review_mode === "compare" ? "baseline" : "playbook";
    if (value.reference_role !== expectedRole) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference_role"],
        message:
          "Compare mode requires a baseline; other modes require a Playbook",
      });
    }
  });

export type ContractPlaybookContextInputV1 = z.infer<
  typeof contractPlaybookContextInputSchema
>;

export const contractPlaybookContextSchema = z
  .object({
    kind: z.literal("contract_playbook_context_v1"),
    context_version: z.literal(CONTRACT_PLAYBOOK_CONTEXT_VERSION),
    workflow_id: z.literal(CONTRACT_PLAYBOOK_WORKFLOW_ID),
    contract: z
      .object({
        document_id: z.string().uuid(),
        version_id: z.string().uuid(),
        filename: bounded(500),
        file_type: z.literal("docx"),
      })
      .strict(),
    reference: z
      .object({
        role: z.enum(["playbook", "baseline"]),
        document_id: z.string().uuid(),
        version_id: z.string().uuid(),
        filename: bounded(500),
        file_type: bounded(80).nullable(),
        rule_set_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        expected_rule_count: z.number().int().min(0).max(500),
      })
      .strict(),
    review: z
      .object({
        mode: z.enum(["quick", "deep", "checklist", "compare"]),
        contract_type: bounded(120),
        represented_side: bounded(120),
        negotiation_posture: z.enum([
          "assertive",
          "balanced",
          "protective",
        ]),
        jurisdiction: bounded(200),
        language: z.enum(["auto", "zh", "en", "bilingual"]),
        background_facts: bounded(2_000),
      })
      .strict(),
  })
  .strict();

export type ContractPlaybookContextV1 = z.infer<
  typeof contractPlaybookContextSchema
>;

export class ContractPlaybookContextError extends Error {
  constructor(
    readonly code:
      | "contract_playbook_input_invalid"
      | "contract_playbook_workflow_mismatch"
      | "contract_playbook_source_missing"
      | "contract_playbook_contract_not_docx"
      | "contract_playbook_rule_set_invalid",
    message: string,
    readonly facts: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ContractPlaybookContextError";
  }
}

export function compileContractPlaybookContext(input: {
  matter: MatterContextManifestV1;
  packInput: unknown;
  referenceRuleSet: {
    digest: string;
    expectedRuleCount: number;
  };
}): ContractPlaybookContextV1 {
  const parsed = contractPlaybookContextInputSchema.safeParse(input.packInput);
  if (!parsed.success) {
    throw new ContractPlaybookContextError(
      "contract_playbook_input_invalid",
      "Contract Playbook input must be explicit and structurally valid.",
      { issues: parsed.error.issues },
    );
  }
  if (input.matter.workflow?.id !== CONTRACT_PLAYBOOK_WORKFLOW_ID) {
    throw new ContractPlaybookContextError(
      "contract_playbook_workflow_mismatch",
      "Contract Playbook context requires the fixed Contract Playbook workflow.",
      { workflow_id: input.matter.workflow?.id ?? null },
    );
  }
  const sourceById = new Map(
    input.matter.sources.map((source) => [source.document_id, source]),
  );
  const contract = sourceById.get(parsed.data.contract_document_id);
  const reference = sourceById.get(parsed.data.reference_document_id);
  if (!contract || !reference) {
    throw new ContractPlaybookContextError(
      "contract_playbook_source_missing",
      "The explicitly selected contract and reference must both be fixed Matter sources.",
      {
        contract_document_id: parsed.data.contract_document_id,
        reference_document_id: parsed.data.reference_document_id,
      },
    );
  }
  if (contract.file_type?.toLowerCase() !== "docx") {
    throw new ContractPlaybookContextError(
      "contract_playbook_contract_not_docx",
      "The fixed contract must be a current Matter DOCX Version.",
      { file_type: contract.file_type },
    );
  }
  const ruleSet = z
    .object({
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      expectedRuleCount: z.number().int().min(0).max(500),
    })
    .strict()
    .safeParse(input.referenceRuleSet);
  if (!ruleSet.success) {
    throw new ContractPlaybookContextError(
      "contract_playbook_rule_set_invalid",
      "The server could not bind the fixed reference to one versioned rule set.",
      { issues: ruleSet.error.issues },
    );
  }
  return contractPlaybookContextSchema.parse({
    kind: "contract_playbook_context_v1",
    context_version: CONTRACT_PLAYBOOK_CONTEXT_VERSION,
    workflow_id: CONTRACT_PLAYBOOK_WORKFLOW_ID,
    contract: {
      document_id: contract.document_id,
      version_id: contract.version_id,
      filename: contract.filename,
      file_type: "docx",
    },
    reference: {
      role: parsed.data.reference_role,
      document_id: reference.document_id,
      version_id: reference.version_id,
      filename: reference.filename,
      file_type: reference.file_type,
      rule_set_digest: ruleSet.data.digest,
      expected_rule_count: ruleSet.data.expectedRuleCount,
    },
    review: {
      mode: parsed.data.review_mode,
      contract_type: parsed.data.contract_type,
      represented_side: parsed.data.represented_side,
      negotiation_posture: parsed.data.negotiation_posture,
      jurisdiction: parsed.data.jurisdiction,
      language: parsed.data.language,
      background_facts: parsed.data.background_facts,
    },
  });
}
