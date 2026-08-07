import type { Document, Message, Workflow } from "../components/shared/types";

export function buildWorkflowChatStartMessage(args: {
    workflow: Workflow;
    documents: Document[];
    assistantPrompt: string;
    model: string;
}): Message {
    const files = args.documents.map((document) => ({
        filename: document.filename,
        document_id: document.id,
    }));
    const additionalPrompt = args.assistantPrompt.trim();

    return {
        role: "user",
        content: additionalPrompt
            ? `implement workflow\n${additionalPrompt}`
            : "implement workflow",
        files: files.length > 0 ? files : undefined,
        workflow: {
            id: args.workflow.id,
            title: args.workflow.metadata.title,
        },
        model: args.model,
    };
}

export function buildWorkflowTaskGoal(args: {
    workflowTitle: string;
    assistantPrompt: string;
}) {
    const additionalPrompt = args.assistantPrompt.trim();
    const workflowGoal = `Run ${args.workflowTitle}.`;
    return additionalPrompt
        ? `${workflowGoal}\n\nAdditional instructions: ${additionalPrompt}`
        : workflowGoal;
}
