import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import mammoth from "mammoth";

import {
    buildTabularReviewWordMemo,
    isTabularReviewWordMemoWithinUploadLimit,
} from "./exportToWordMemo";
import { MAX_PROJECT_DOCUMENT_BYTES } from "./exportToExcel";

test("builds an editable Word memo with findings, analysis, and source notes", async () => {
    const result = await buildTabularReviewWordMemo({
        reviewTitle: "跨境 / 合同审阅",
        matterName: "星河项目",
        columns: [{ index: 0, name: "自动续期", prompt: "识别自动续期条款" }],
        documents: [
            {
                id: "document-1",
                project_id: "matter-1",
                filename: "供应商主协议.docx",
                file_type: "docx",
                storage_path: null,
                pdf_storage_path: null,
                size_bytes: null,
                page_count: null,
                structure_tree: null,
                status: "ready",
                created_at: null,
            },
        ],
        cells: [
            {
                id: "cell-1",
                review_id: "review-1",
                document_id: "document-1",
                column_index: 0,
                status: "done",
                created_at: "2026-07-22T00:00:00.000Z",
                content: {
                    flag: "yellow",
                    summary:
                        "合同会自动续期。[[page:4||quote:本合同将在期限届满时自动续期一年。]]",
                    reasoning:
                        "续期价格可调整。[[sheet:报价表||cell:F18||quote:续期价格为人民币125000元。]]",
                },
            },
        ],
    });

    assert.equal(result.filename, "跨境 合同审阅 - Review Memo.docx");
    assert.equal(
        result.blob.type,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const extracted = await mammoth.extractRawText({
        buffer: Buffer.from(await result.blob.arrayBuffer()),
    });
    assert.match(extracted.value, /DRAFT — LAWYER REVIEW REQUIRED/);
    assert.match(extracted.value, /Matter: 星河项目/);
    assert.match(extracted.value, /供应商主协议\.docx/);
    assert.match(extracted.value, /合同会自动续期。 \[C-01-01-F-01\]/);
    assert.match(extracted.value, /Analysis: 续期价格可调整。 \[C-01-01-A-01\]/);
    assert.match(extracted.value, /Page 4/);
    assert.match(extracted.value, /报价表!F18/);
    assert.match(extracted.value, /本合同将在期限届满时自动续期一年。/);
    assert.match(extracted.value, /续期价格为人民币125000元。/);
    if (process.env.VERA_WORD_MEMO_QA_PATH) {
        await writeFile(
            process.env.VERA_WORD_MEMO_QA_PATH,
            Buffer.from(await result.blob.arrayBuffer()),
        );
    }
});

test("warns when citations are missing and reuses the Matter upload limit", async () => {
    const result = await buildTabularReviewWordMemo({
        reviewTitle: "No citations",
        columns: [{ index: 0, name: "Conclusion", prompt: "Review" }],
        documents: [],
        cells: [],
    });
    const extracted = await mammoth.extractRawText({
        buffer: Buffer.from(await result.blob.arrayBuffer()),
    });
    assert.match(extracted.value, /No source citations were present/);
    assert.equal(
        isTabularReviewWordMemoWithinUploadLimit({
            size: MAX_PROJECT_DOCUMENT_BYTES,
        } as Blob),
        true,
    );
    assert.equal(
        isTabularReviewWordMemoWithinUploadLimit({
            size: MAX_PROJECT_DOCUMENT_BYTES + 1,
        } as Blob),
        false,
    );
});
