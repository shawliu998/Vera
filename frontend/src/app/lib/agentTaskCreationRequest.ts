export interface AgentTaskCreationInput {
  goal: string;
  matterId: string;
  model: string;
  documentIds?: string[];
  workflowId?: string;
  sourceAcquisition?: {
    query: string;
    jurisdiction: string;
    asOfDate: string;
  };
}

export function buildAgentTaskCreationBody(input: AgentTaskCreationInput) {
  return {
    goal: input.goal,
    matter_id: input.matterId,
    model: input.model,
    document_ids: input.documentIds ?? [],
    ...(input.workflowId ? { workflow_id: input.workflowId } : {}),
    ...(input.sourceAcquisition
      ? {
          source_acquisition: {
            query: input.sourceAcquisition.query,
            jurisdiction: input.sourceAcquisition.jurisdiction,
            as_of_date: input.sourceAcquisition.asOfDate,
          },
        }
      : {}),
  };
}
