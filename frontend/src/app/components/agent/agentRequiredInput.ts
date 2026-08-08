import type {
  AgentCheckpoint,
  AgentRequiredInput,
  AgentRequiredInputResponse,
} from "@/app/types/agent";

export const AGENT_INPUT_MESSAGE_LIMIT = 4000;

export function getAgentRequiredInput(
  checkpoint: AgentCheckpoint | null | undefined,
): AgentRequiredInput | null {
  const value = checkpoint?.required_input;
  if (
    !value ||
    value.kind !== "required_input_v1" ||
    !value.request_id?.trim() ||
    !Array.isArray(value.items) ||
    value.items.length === 0
  ) {
    return null;
  }
  return value;
}

export function agentRequiredInputNeedsDocuments(
  requiredInput: AgentRequiredInput,
) {
  return requiredInput.items.some(
    (item) => item.kind === "documents" && item.required !== false,
  );
}

export function buildAgentRequiredInputResponses(input: {
  requiredInput: AgentRequiredInput;
  answers: Record<string, string>;
  documentIds: string[];
}): AgentRequiredInputResponse[] {
  return input.requiredInput.items.flatMap<AgentRequiredInputResponse>(
    (item) => {
      if (item.kind === "documents") {
        return [
          {
            id: item.id,
            kind: "documents" as const,
            document_ids: input.documentIds,
          },
        ];
      }
      const answer = input.answers[item.id]?.trim();
      return answer ? [{ id: item.id, kind: "choice" as const, answer }] : [];
    },
  );
}

export function buildAgentRequiredInputMessage(input: {
  requiredInput: AgentRequiredInput;
  answers: Record<string, string>;
  attachedDocumentCount: number;
  note?: string;
}): string | null {
  if (
    agentRequiredInputNeedsDocuments(input.requiredInput) &&
    input.attachedDocumentCount === 0
  ) {
    return null;
  }

  const decisions: string[] = [];
  for (const item of input.requiredInput.items) {
    if (item.kind !== "choice") continue;
    const answer = input.answers[item.id]?.trim();
    if (!answer) return null;
    decisions.push(
      `${decisions.length + 1}. ${item.response_prefix?.trim() || item.question.trim()}\nDecision: ${answer}`,
    );
  }

  const documentItems = input.requiredInput.items.filter(
    (item) => item.kind === "documents",
  );
  const sections = decisions.length
    ? [`Lawyer decisions:\n${decisions.join("\n\n")}`]
    : [];
  if (documentItems.length) {
    sections.push(
      input.attachedDocumentCount > 0
        ? `Supporting Matter documents attached: ${input.attachedDocumentCount}.`
        : "No optional supporting documents attached. Preserve unknown facts as unresolved and continue without guessing.",
    );
  }
  const note = input.note?.trim();
  if (note) sections.push(`Additional lawyer note:\n${note}`);

  const message = sections.join("\n\n").trim();
  return message && message.length <= AGENT_INPUT_MESSAGE_LIMIT
    ? message
    : null;
}
