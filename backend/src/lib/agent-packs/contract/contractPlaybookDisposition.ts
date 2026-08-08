import {
  createAgentRequiredInput,
  validateRequiredInputSubmission,
  type AgentRequiredInputResponseV1,
  type AgentRequiredInputV1,
} from "../../agent-kernel/contracts/requiredInput";
import {
  compileContractPlaybookReceipt,
  contractLawyerDispositionSchema,
  contractPlaybookReceiptSchema,
  type ContractPlaybookReceiptV1,
} from "./contractPlaybookPack";
import { z } from "zod";

const FINDING_ITEM_PREFIX = "contract-finding:";
const MAX_FINDINGS_PER_REQUEST = 8;

const contractPlaybookDispositionRevisionDecisionSchema = z
  .object({
    finding_id: z.string().regex(/^finding-[a-f0-9]{24}$/),
    disposition: contractLawyerDispositionSchema,
    direction: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.direction !== null && decision.disposition !== "comment") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["direction"],
        message: "Only a comment disposition may carry lawyer direction",
      });
    }
  });

export const contractPlaybookDispositionRevisionIntentSchema = z
  .object({
    kind: z.literal("contract_playbook_disposition_revision_v1"),
    analyze_step_id: z.string().uuid(),
    analyze_attempt: z.number().int().positive(),
    contract_version_id: z.string().uuid(),
    reference_version_id: z.string().uuid(),
    decisions: z
      .array(contractPlaybookDispositionRevisionDecisionSchema)
      .min(1)
      .max(80),
  })
  .strict();

export type ContractPlaybookDispositionRevisionIntent = z.infer<
  typeof contractPlaybookDispositionRevisionIntentSchema
>;

function receiptAnalysisFinding(
  finding: ContractPlaybookReceiptV1["findings"][number],
) {
  const {
    finding_id: _findingId,
    lawyer_disposition: _lawyerDisposition,
    lawyer_direction: _lawyerDirection,
    ...analysis
  } = finding;
  return analysis;
}

/**
 * Bind one complete lawyer-disposition correction to the exact fixed analysis
 * receipt. The intent is stored on the existing Review Decision and is applied
 * only when the server starts the corresponding revision.
 */
export function createContractPlaybookDispositionRevisionIntent(input: {
  receipt: ContractPlaybookReceiptV1;
  decisions: unknown;
}): ContractPlaybookDispositionRevisionIntent {
  const receipt = contractPlaybookReceiptSchema.parse(input.receipt);
  const decisions = z
    .array(contractPlaybookDispositionRevisionDecisionSchema)
    .min(1)
    .max(80)
    .parse(input.decisions);
  const material = receipt.findings.filter((finding) => finding.material);
  const materialIds = new Set(material.map((finding) => finding.finding_id));
  const decisionIds = decisions.map((decision) => decision.finding_id);
  if (
    new Set(decisionIds).size !== decisionIds.length ||
    decisionIds.length !== materialIds.size ||
    decisionIds.some((findingId) => !materialIds.has(findingId))
  ) {
    throw new Error(
      "Contract disposition revision must decide every fixed material finding exactly once",
    );
  }

  const byFinding = new Map(
    decisions.map((decision) => [decision.finding_id, decision]),
  );
  const changed = material.some((finding) => {
    const decision = byFinding.get(finding.finding_id)!;
    return (
      decision.disposition !== finding.lawyer_disposition ||
      decision.direction !== finding.lawyer_direction
    );
  });
  if (!changed) {
    throw new Error(
      "Contract disposition revision must change at least one lawyer decision",
    );
  }

  // Recompile once now so an invalid accept/comment combination is rejected
  // before the append-only Review Decision is recorded.
  compileContractPlaybookReceipt({
    reviewMode: receipt.review_mode,
    opinionLanguage: receipt.opinion_language,
    analyzeStepId: receipt.analyze_step_id,
    analyzeAttempt: receipt.analyze_attempt,
    contract: receipt.contract,
    reference: receipt.reference,
    citationSnapshotArtifactId: receipt.citation_snapshot_artifact_id,
    findings: receipt.findings.map(receiptAnalysisFinding),
    decisions: Object.fromEntries(
      decisions.map((decision) => [
        decision.finding_id,
        {
          disposition: decision.disposition,
          direction: decision.direction,
        },
      ]),
    ),
  });

  return contractPlaybookDispositionRevisionIntentSchema.parse({
    kind: "contract_playbook_disposition_revision_v1",
    analyze_step_id: receipt.analyze_step_id,
    analyze_attempt: receipt.analyze_attempt,
    contract_version_id: receipt.contract.version_id,
    reference_version_id: receipt.reference.version_id,
    decisions,
  });
}

export function applyContractPlaybookDispositionRevisionIntent(input: {
  receipt: ContractPlaybookReceiptV1;
  intent: unknown;
}) {
  const receipt = contractPlaybookReceiptSchema.parse(input.receipt);
  const intent = contractPlaybookDispositionRevisionIntentSchema.parse(
    input.intent,
  );
  if (
    intent.analyze_step_id !== receipt.analyze_step_id ||
    intent.analyze_attempt !== receipt.analyze_attempt ||
    intent.contract_version_id !== receipt.contract.version_id ||
    intent.reference_version_id !== receipt.reference.version_id
  ) {
    throw new Error(
      "Contract disposition revision no longer matches the fixed analysis receipt",
    );
  }
  const rebound = createContractPlaybookDispositionRevisionIntent({
    receipt,
    decisions: intent.decisions,
  });
  const decisions = Object.fromEntries(
    rebound.decisions.map((decision) => [
      decision.finding_id,
      {
        disposition: decision.disposition,
        direction: decision.direction,
      },
    ]),
  );
  return compileContractPlaybookReceipt({
    reviewMode: receipt.review_mode,
    opinionLanguage: receipt.opinion_language,
    analyzeStepId: receipt.analyze_step_id,
    analyzeAttempt: receipt.analyze_attempt,
    contract: receipt.contract,
    reference: receipt.reference,
    citationSnapshotArtifactId: receipt.citation_snapshot_artifact_id,
    findings: receipt.findings.map(receiptAnalysisFinding),
    decisions,
  });
}

export function assertContractPlaybookDispositionRevisionApplied(input: {
  receipt: ContractPlaybookReceiptV1;
  intent: unknown;
}) {
  const receipt = contractPlaybookReceiptSchema.parse(input.receipt);
  const intent = contractPlaybookDispositionRevisionIntentSchema.parse(
    input.intent,
  );
  if (
    intent.analyze_step_id !== receipt.analyze_step_id ||
    intent.analyze_attempt !== receipt.analyze_attempt ||
    intent.contract_version_id !== receipt.contract.version_id ||
    intent.reference_version_id !== receipt.reference.version_id
  ) {
    throw new Error(
      "Contract disposition revision no longer matches the fixed analysis receipt",
    );
  }
  const material = receipt.findings.filter((finding) => finding.material);
  const byFinding = new Map(
    intent.decisions.map((decision) => [decision.finding_id, decision]),
  );
  if (
    byFinding.size !== intent.decisions.length ||
    byFinding.size !== material.length ||
    material.some((finding) => {
      const decision = byFinding.get(finding.finding_id);
      return (
        !decision ||
        decision.disposition !== finding.lawyer_disposition ||
        decision.direction !== finding.lawyer_direction
      );
    })
  ) {
    throw new Error(
      "Contract disposition revision was not applied to every fixed material finding",
    );
  }
  return intent;
}

function boundedText(value: string | null, maximum: number) {
  if (!value) return "No fixed recommendation supplied.";
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

export function createContractPlaybookDispositionRequiredInput(input: {
  receipt: ContractPlaybookReceiptV1;
  stepId: string;
  createdAt?: string;
}): AgentRequiredInputV1 | null {
  const receipt = contractPlaybookReceiptSchema.parse(input.receipt);
  const unresolved = receipt.findings
    .filter(
      (finding) => finding.material && finding.lawyer_disposition === null,
    )
    .slice(0, MAX_FINDINGS_PER_REQUEST);
  if (!unresolved.length) return null;
  return createAgentRequiredInput({
    stepId: input.stepId,
    reasonCode: "lawyer_choice",
    createdAt: input.createdAt,
    prompt:
      "Decide each fixed material contract finding. Accept adopts only the fixed proposed text; Comment preserves the operative text and records the fixed recommendation or your direction; Skip preserves the operative text without a document action.",
    items: unresolved.map((finding) => ({
      id: `${FINDING_ITEM_PREFIX}${finding.finding_id}`,
      kind: "choice" as const,
      question: [
        `${finding.rule_id} · ${finding.risk_level.toUpperCase()}`,
        `Fixed source span: ${boundedText(finding.contract_quote, 360)}`,
        `Recommendation: ${boundedText(finding.recommendation, 360)}`,
      ].join("\n"),
      options: [
        ...(finding.proposed_text &&
        finding.contract_quote &&
        finding.contract_anchor
          ? [
              {
                value: "accept",
                label: `Accept fixed text: ${boundedText(finding.proposed_text, 360)}`,
              },
            ]
          : []),
        {
          value: "comment",
          label: "Comment — keep text and record the fixed recommendation",
        },
        {
          value: "skip",
          label: "Skip — keep text with no document action",
        },
      ],
      allow_other: true,
      other_label: "Comment with lawyer direction",
      response_prefix: finding.finding_id,
    })),
  });
}

export function applyContractPlaybookDispositionResponses(input: {
  receipt: ContractPlaybookReceiptV1;
  requiredInput: AgentRequiredInputV1;
  responses: AgentRequiredInputResponseV1[];
}) {
  const receipt = contractPlaybookReceiptSchema.parse(input.receipt);
  const expected = createContractPlaybookDispositionRequiredInput({
    receipt,
    stepId: input.requiredInput.step_id,
    createdAt: input.requiredInput.created_at,
  });
  if (!expected || expected.request_id !== input.requiredInput.request_id) {
    throw new Error(
      "Contract finding decisions do not match the active server request",
    );
  }
  const validated = validateRequiredInputSubmission(expected, {
    responses: input.responses,
  });
  const answers = new Map(
    (validated.responses ?? []).flatMap((response) =>
      response.kind === "choice" ? [[response.id, response.answer]] : [],
    ),
  );
  const decisions = Object.fromEntries(
    receipt.findings.flatMap((finding) => {
      if (finding.lawyer_disposition) {
        return [
          [
            finding.finding_id,
            {
              disposition: finding.lawyer_disposition,
              direction: finding.lawyer_direction,
            },
          ],
        ];
      }
      const answer = answers.get(`${FINDING_ITEM_PREFIX}${finding.finding_id}`);
      if (!answer) return [];
      return [
        [
          finding.finding_id,
          answer === "accept" || answer === "skip" || answer === "comment"
            ? { disposition: answer, direction: null }
            : { disposition: "comment", direction: answer },
        ],
      ];
    }),
  );
  return compileContractPlaybookReceipt({
    reviewMode: receipt.review_mode,
    opinionLanguage: receipt.opinion_language,
    analyzeStepId: receipt.analyze_step_id,
    analyzeAttempt: receipt.analyze_attempt,
    contract: receipt.contract,
    reference: receipt.reference,
    citationSnapshotArtifactId: receipt.citation_snapshot_artifact_id,
    findings: receipt.findings.map(receiptAnalysisFinding),
    decisions,
  });
}
