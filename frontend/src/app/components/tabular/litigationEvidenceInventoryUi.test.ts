import assert from "node:assert/strict";
import test from "node:test";

import {
    canRequestSourceBoundCorrection,
    DEFAULT_SOURCE_BOUND_CORRECTION_REASON,
    evidenceInventoryReviewCompleteResponse,
    litigationEvidenceSideLabel,
    litigationEvidenceStageLabel,
    SOURCE_BOUND_CORRECTION_REASONS,
    sourceBoundCorrectionRequestBody,
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

test("offers source-bound regeneration only for an active, eligible finding", () => {
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "done",
            reviewStatus: null,
            reviewRevision: 0,
        }),
        true,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: false,
            cellStatus: "done",
            reviewStatus: null,
            reviewRevision: 0,
        }),
        false,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "pending",
            reviewStatus: null,
            reviewRevision: 0,
        }),
        true,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "pending",
            reviewStatus: "needs_correction",
            reviewRevision: 0,
        }),
        true,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "generating",
            reviewStatus: null,
            reviewRevision: 0,
        }),
        false,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "error",
            reviewStatus: null,
            reviewRevision: 0,
        }),
        false,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "done",
            reviewStatus: "verified",
            reviewRevision: 0,
        }),
        false,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "done",
            reviewStatus: "unresolved",
            reviewRevision: 0,
        }),
        false,
    );
    assert.equal(
        canRequestSourceBoundCorrection({
            taskWaitingForReview: true,
            cellStatus: "done",
            reviewStatus: "needs_correction",
            reviewRevision: 0,
        }),
        true,
    );
});

test("serializes the closed source-bound correction contract", () => {
    assert.deepEqual(
        sourceBoundCorrectionRequestBody({
            expectedReviewRevision: 4,
            reasonCode: DEFAULT_SOURCE_BOUND_CORRECTION_REASON,
        }),
        {
            expected_review_revision: 4,
            reason_code: "citation_not_exact",
        },
    );
    assert.deepEqual(
        SOURCE_BOUND_CORRECTION_REASONS.map((reason) => reason.code),
        ["citation_not_exact", "source_conflict", "material_omission"],
    );
});

test("posts one source-bound correction request for the selected Cell", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY = "test-key";
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://vera.test";
    const { requestLitigationEvidenceSourceBoundCorrection } = await import(
        "@/app/lib/mikeApi"
    );
    const originalFetch = globalThis.fetch;
    let request: { url: string; init?: RequestInit } | null = null;
    globalThis.fetch = (async (input, init) => {
        request = { url: String(input), init };
        return new Response(
            JSON.stringify({
                task_id: "task-1",
                task_status: "running",
                review_id: "review-1",
                context: {
                    procedural_stage: "first_instance",
                    represented_side: "defendant_respondent",
                },
                progress: {
                    total: 5,
                    generated: 4,
                    verified: 2,
                    unresolved: 1,
                    needs_correction: 0,
                    remaining: 2,
                    first_incomplete_cell_id: "cell-1",
                },
                cell: {
                    cell_id: "cell-1",
                    cell_status: "pending",
                    review_status: null,
                    review_revision: 3,
                    reviewed_at: null,
                },
            }),
            { status: 202, headers: { "Content-Type": "application/json" } },
        );
    }) as typeof fetch;
    try {
        await requestLitigationEvidenceSourceBoundCorrection(
            "review-1",
            "cell-1",
            {
                expectedReviewRevision: 2,
                reasonCode: "source_conflict",
            },
        );
        assert.deepEqual(request, {
            url: "http://vera.test/tabular-review/review-1/cells/cell-1/source-bound-correction",
            init: {
                cache: "no-store",
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    expected_review_revision: 2,
                    reason_code: "source_conflict",
                }),
            },
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
