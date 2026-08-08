import assert from "node:assert/strict";
import test from "node:test";

import {
    evidenceInventoryReviewCompleteResponse,
    litigationEvidenceSideLabel,
    litigationEvidenceStageLabel,
} from "./litigationEvidenceInventoryUi";

test("labels the server-owned first-instance Litigation context", () => {
    const context = {
        procedural_stage: "first_instance" as const,
        represented_side: "defendant_respondent" as const,
    };
    assert.equal(litigationEvidenceStageLabel(context), "First instance");
    assert.equal(
        litigationEvidenceSideLabel(context),
        "Defendant / respondent",
    );
});

test("submits the server-required evidence review response exactly", () => {
    assert.deepEqual(evidenceInventoryReviewCompleteResponse(), [
        {
            id: "evidence-inventory-reviewed",
            kind: "choice",
            answer: "review_complete",
        },
    ]);
});
