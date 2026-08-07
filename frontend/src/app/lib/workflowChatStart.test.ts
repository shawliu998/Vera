import assert from "node:assert/strict";
import test from "node:test";
import type { Document, Workflow } from "../components/shared/types";
import { buildWorkflowChatStartMessage } from "./workflowChatStart";

const workflow = {
    id: "builtin-patentability-assessment",
    metadata: {
        title: "Patentability Assessment",
    },
} as Workflow;

const documents = [
    {
        id: "source-1",
        filename: "target-claim.docx",
    },
    {
        id: "source-2",
        filename: "prior-art.docx",
    },
] as Document[];

test("workflow auto-start preserves the selected model on the submitted message", () => {
    const message = buildWorkflowChatStartMessage({
        workflow,
        documents,
        assistantPrompt: "  Use the fixed synthetic fixture only.  ",
        model: "deepseek-v4-flash",
    });

    assert.equal(message.model, "deepseek-v4-flash");
    assert.equal(
        message.content,
        "implement workflow\nUse the fixed synthetic fixture only.",
    );
    assert.deepEqual(message.workflow, {
        id: workflow.id,
        title: workflow.metadata.title,
    });
    assert.deepEqual(message.files, [
        { filename: "target-claim.docx", document_id: "source-1" },
        { filename: "prior-art.docx", document_id: "source-2" },
    ]);
});
