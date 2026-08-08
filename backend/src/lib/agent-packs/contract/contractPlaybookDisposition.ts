import {
  createAgentRequiredInput,
  validateRequiredInputSubmission,
  type AgentRequiredInputResponseV1,
  type AgentRequiredInputV1,
} from "../../agent-kernel/contracts/requiredInput";
import {
  compileContractPlaybookReceipt,
  contractPlaybookReceiptSchema,
  type ContractPlaybookReceiptV1,
} from "./contractPlaybookPack";

const FINDING_ITEM_PREFIX = "contract-finding:";
const MAX_FINDINGS_PER_REQUEST = 8;

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
      question: `${finding.rule_id} · ${finding.risk_level.toUpperCase()} · ${boundedText(finding.recommendation, 360)}`,
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

function analysisFinding(
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
    findings: receipt.findings.map(analysisFinding),
    decisions,
  });
}
