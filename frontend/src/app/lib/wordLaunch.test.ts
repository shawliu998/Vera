import assert from "node:assert/strict";
import test from "node:test";

import {
    downloadDocumentVersionForWord,
    openDocumentVersionInWord,
    WordLaunchError,
    wordLaunchUri,
} from "./wordLaunch";

const DOCX_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("builds a Word launch URI only from HTTP(S)", () => {
    assert.equal(
        wordLaunchUri("https://files.example.test/memo.docx?signature=abc"),
        "ms-word:ofe|u|https://files.example.test/memo.docx?signature=abc",
    );
    assert.throws(() => wordLaunchUri("file:///tmp/memo.docx"));
    assert.throws(() =>
        wordLaunchUri("https://files.example.test/memo|bad.docx"),
    );
});

test("opens the exact requested Version and returns a bounded launch receipt", async () => {
    const navigated: string[] = [];
    const receipt = await openDocumentVersionInWord(
        "document-7",
        "version-9",
        {
            getDocumentUrl: async () => ({
                url: "https://files.example.test/memo.docx?version=9",
                filename: "memo.docx",
                version_id: "version-9",
            }),
            navigate: (uri) => navigated.push(uri),
        },
    );
    assert.deepEqual(navigated, [
        "ms-word:ofe|u|https://files.example.test/memo.docx?version=9",
    ]);
    assert.deepEqual(receipt, {
        status: "launch_requested",
        documentId: "document-7",
        requestedVersionId: "version-9",
        resolvedVersionId: "version-9",
        signedUrl: "https://files.example.test/memo.docx?version=9",
        launchUri:
            "ms-word:ofe|u|https://files.example.test/memo.docx?version=9",
    });
});

test("fails closed when the signed URL resolves another Version", async () => {
    const navigated: string[] = [];
    await assert.rejects(
        openDocumentVersionInWord("document-7", "version-9", {
            getDocumentUrl: async () => ({
                url: "https://files.example.test/memo.docx?version=8",
                filename: "memo.docx",
                version_id: "version-8",
            }),
            navigate: (uri) => navigated.push(uri),
        }),
        (error: unknown) => {
            assert.ok(error instanceof WordLaunchError);
            assert.equal(error.code, "version_mismatch");
            return true;
        },
    );
    assert.deepEqual(navigated, []);
});

test("reports signed URL and protocol launch failures without fallback", async () => {
    await assert.rejects(
        openDocumentVersionInWord("document-7", "version-9", {
            getDocumentUrl: async () => {
                throw new Error("expired");
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof WordLaunchError);
            assert.equal(error.code, "document_url_unavailable");
            assert.equal(error.documentId, "document-7");
            assert.equal(error.versionId, "version-9");
            return true;
        },
    );

    await assert.rejects(
        openDocumentVersionInWord("document-7", "version-9", {
            getDocumentUrl: async () => ({
                url: "https://files.example.test/memo.docx?version=9",
                filename: "memo.docx",
                version_id: "version-9",
            }),
            navigate: () => {
                throw new Error("protocol unavailable");
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof WordLaunchError);
            assert.equal(error.code, "word_launch_failed");
            return true;
        },
    );
});

test("downloads exact DOCX bytes without claiming Word opened them", async () => {
    const downloads: Array<[Blob, string]> = [];
    const docx = new Blob(["docx"], { type: DOCX_TYPE });
    const receipt = await downloadDocumentVersionForWord(
        "document-7",
        "version-9",
        {
            getDocumentUrl: async () => ({
                url: "https://files.example.test/memo.docx?version=9",
                filename: "合同修订稿 V9.docx",
                version_id: "version-9",
            }),
            getDocumentBytes: async () => docx,
            download: (blob, filename) => downloads.push([blob, filename]),
        },
    );
    assert.deepEqual(downloads, [[docx, "合同修订稿 V9.docx"]]);
    assert.equal(receipt.status, "download_requested");
    assert.equal(receipt.resolvedVersionId, "version-9");
    assert.equal(receipt.byteLength, docx.size);
    assert.equal("launchUri" in receipt, false);
});

test("rejects invalid or empty download bytes before writing a file", async () => {
    const downloads: Array<[Blob, string]> = [];
    const getDocumentUrl = async () => ({
        url: "https://files.example.test/memo.docx?version=9",
        filename: "memo.docx",
        version_id: "version-9",
    });
    for (const blob of [
        new Blob(["not docx"], { type: "text/plain" }),
        new Blob([], { type: DOCX_TYPE }),
    ]) {
        await assert.rejects(
            downloadDocumentVersionForWord("document-7", "version-9", {
                getDocumentUrl,
                getDocumentBytes: async () => blob,
                download: (value, filename) =>
                    downloads.push([value, filename]),
            }),
            /verify the requested DOCX bytes/,
        );
    }
    assert.deepEqual(downloads, []);
});
