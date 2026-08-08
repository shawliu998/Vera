import { z } from "zod";

import type { MatterContextManifestV1 } from "../../agent-kernel/context/matterContext";
import {
  createAgentRequiredInput,
  validateRequiredInputSubmission,
  type AgentRequiredInputResponseV1,
  type AgentRequiredInputV1,
} from "../../agent-kernel/contracts/requiredInput";

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
        negotiation_posture: z.enum(["assertive", "balanced", "protective"]),
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
      | "contract_playbook_rule_set_invalid"
      | "contract_playbook_source_scope_too_large",
    message: string,
    readonly facts: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ContractPlaybookContextError";
  }
}

const CONTRACT_CONTEXT_ITEM_IDS = {
  contractDocument: "contract-document-id",
  referenceDocument: "reference-document-id",
  reviewMode: "review-mode",
  contractType: "contract-type",
  representedSide: "represented-side",
  negotiationPosture: "negotiation-posture",
  jurisdiction: "jurisdiction",
  language: "review-language",
  backgroundFacts: "background-facts",
} as const;

export function readContractPlaybookContext(value: unknown) {
  if (value === undefined || value === null) return null;
  const parsed = contractPlaybookContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractPlaybookContextError(
      "contract_playbook_input_invalid",
      "The fixed Contract Playbook context is malformed.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function createContractPlaybookContextRequiredInput(input: {
  matter: MatterContextManifestV1;
  stepId: string;
  createdAt?: string;
}): AgentRequiredInputV1 {
  if (input.matter.workflow?.id !== CONTRACT_PLAYBOOK_WORKFLOW_ID) {
    throw new ContractPlaybookContextError(
      "contract_playbook_workflow_mismatch",
      "Contract Playbook input requires the fixed Contract Playbook workflow.",
    );
  }
  const contractCandidates = input.matter.sources.filter(
    (source) => source.file_type?.toLowerCase() === "docx",
  );
  if (!contractCandidates.length || input.matter.sources.length < 2) {
    throw new ContractPlaybookContextError(
      "contract_playbook_source_missing",
      "Contract Playbook review requires one fixed DOCX contract and one distinct fixed reference.",
    );
  }
  if (contractCandidates.length > 16 || input.matter.sources.length > 16) {
    throw new ContractPlaybookContextError(
      "contract_playbook_source_scope_too_large",
      "Narrow the fixed source set to at most 16 documents before choosing the contract and reference.",
      {
        contract_candidate_count: contractCandidates.length,
        fixed_source_count: input.matter.sources.length,
      },
    );
  }
  const sourceOptions = input.matter.sources.map((source) => ({
    value: source.document_id,
    label: `${source.filename} · ${source.file_type ?? "file"}`,
  }));
  return createAgentRequiredInput({
    stepId: input.stepId,
    reasonCode: "lawyer_choice",
    createdAt: input.createdAt,
    prompt:
      "Fix the contract, reference, review scope, represented side, and lawyer posture before analysis. Vera will bind the selected current Versions and will not ask the model to guess them.",
    items: [
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.contractDocument,
        kind: "choice",
        question: "Which fixed DOCX is the contract to review?",
        options: contractCandidates.map((source) => ({
          value: source.document_id,
          label: source.filename,
        })),
        allow_other: false,
        other_label: "Other",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.referenceDocument,
        kind: "choice",
        question:
          "Which distinct fixed document is the Playbook, or the baseline in compare mode?",
        options: sourceOptions,
        allow_other: false,
        other_label: "Other",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.reviewMode,
        kind: "choice",
        question: "Which review mode should Vera run?",
        options: [
          { value: "deep", label: "Deep review" },
          { value: "quick", label: "Quick material-risk review" },
          { value: "checklist", label: "Complete Playbook checklist" },
          { value: "compare", label: "Compare against baseline" },
        ],
        allow_other: false,
        other_label: "Other",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.contractType,
        kind: "choice",
        question:
          "What contract family should select the fixed Playbook overlay?",
        options: [
          { value: "sale_procurement", label: "Sale / procurement" },
          { value: "services_commission", label: "Services / commission" },
          { value: "nda", label: "Confidentiality / NDA" },
          { value: "employment_consulting", label: "Employment / consulting" },
          { value: "software_services", label: "Software / SaaS / licence" },
        ],
        allow_other: true,
        other_label: "Other contract family",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.representedSide,
        kind: "choice",
        question: "Which party does the reviewing lawyer represent?",
        options: [
          { value: "buyer_customer", label: "Buyer / customer" },
          { value: "seller_supplier", label: "Seller / supplier" },
          { value: "discloser", label: "Disclosing party" },
          { value: "recipient", label: "Receiving party" },
          { value: "employer_client", label: "Employer / client" },
          { value: "employee_consultant", label: "Employee / consultant" },
        ],
        allow_other: true,
        other_label: "Other represented side",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.negotiationPosture,
        kind: "choice",
        question: "What fixed negotiation posture should be applied?",
        options: [
          { value: "balanced", label: "Balanced" },
          { value: "protective", label: "Protective" },
          { value: "assertive", label: "Assertive" },
        ],
        allow_other: false,
        other_label: "Other",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.jurisdiction,
        kind: "choice",
        question: "Which jurisdiction should frame unresolved legal questions?",
        options: [
          { value: "China (PRC)", label: "China (PRC)" },
          { value: "Hong Kong SAR", label: "Hong Kong SAR" },
          { value: "England and Wales", label: "England and Wales" },
          {
            value: "New York, United States",
            label: "New York, United States",
          },
        ],
        allow_other: true,
        other_label: "Other jurisdiction",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.language,
        kind: "choice",
        question: "Which language should the review outputs use?",
        options: [
          { value: "auto", label: "Match the contract" },
          { value: "zh", label: "Chinese" },
          { value: "en", label: "English" },
          { value: "bilingual", label: "Bilingual Chinese / English" },
        ],
        allow_other: false,
        other_label: "Other",
      },
      {
        id: CONTRACT_CONTEXT_ITEM_IDS.backgroundFacts,
        kind: "choice",
        question:
          "What material background facts may Vera use beyond the fixed documents?",
        options: [
          {
            value: "keep_unresolved",
            label: "None supplied — keep unknown facts unresolved",
          },
        ],
        allow_other: true,
        other_label: "Add bounded background facts",
      },
    ],
  });
}

function responseAnswers(responses: AgentRequiredInputResponseV1[]) {
  return new Map(
    responses.flatMap((response) =>
      response.kind === "choice" ? [[response.id, response.answer]] : [],
    ),
  );
}

export function parseContractPlaybookContextRequiredInput(input: {
  matter: MatterContextManifestV1;
  requiredInput: AgentRequiredInputV1;
  responses: AgentRequiredInputResponseV1[];
}): ContractPlaybookContextInputV1 {
  const expected = createContractPlaybookContextRequiredInput({
    matter: input.matter,
    stepId: input.requiredInput.step_id,
    createdAt: input.requiredInput.created_at,
  });
  if (input.requiredInput.request_id !== expected.request_id) {
    throw new ContractPlaybookContextError(
      "contract_playbook_input_invalid",
      "The submitted Contract Playbook choices do not match the active server request.",
    );
  }
  const validated = validateRequiredInputSubmission(expected, {
    responses: input.responses,
  });
  const answers = responseAnswers(validated.responses ?? []);
  const answer = (id: string) => {
    const value = answers.get(id)?.trim();
    if (!value) {
      throw new ContractPlaybookContextError(
        "contract_playbook_input_invalid",
        `A required Contract Playbook choice is missing: ${id}.`,
      );
    }
    return value;
  };
  const reviewMode = answer(CONTRACT_CONTEXT_ITEM_IDS.reviewMode);
  const backgroundFacts = answer(CONTRACT_CONTEXT_ITEM_IDS.backgroundFacts);
  const parsed = contractPlaybookContextInputSchema.safeParse({
    contract_document_id: answer(CONTRACT_CONTEXT_ITEM_IDS.contractDocument),
    reference_document_id: answer(CONTRACT_CONTEXT_ITEM_IDS.referenceDocument),
    reference_role: reviewMode === "compare" ? "baseline" : "playbook",
    review_mode: reviewMode,
    contract_type: answer(CONTRACT_CONTEXT_ITEM_IDS.contractType),
    represented_side: answer(CONTRACT_CONTEXT_ITEM_IDS.representedSide),
    negotiation_posture: answer(CONTRACT_CONTEXT_ITEM_IDS.negotiationPosture),
    jurisdiction: answer(CONTRACT_CONTEXT_ITEM_IDS.jurisdiction),
    language: answer(CONTRACT_CONTEXT_ITEM_IDS.language),
    background_facts:
      backgroundFacts === "keep_unresolved"
        ? "No additional facts supplied; preserve unknown facts as unresolved."
        : backgroundFacts,
  });
  if (!parsed.success) {
    throw new ContractPlaybookContextError(
      "contract_playbook_input_invalid",
      "Contract Playbook choices could not be compiled into a fixed context.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
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
  if (
    parsed.data.review_mode === "compare" &&
    reference.file_type?.toLowerCase() !== "docx"
  ) {
    throw new ContractPlaybookContextError(
      "contract_playbook_input_invalid",
      "Compare mode requires a distinct fixed DOCX baseline.",
      { reference_file_type: reference.file_type },
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
