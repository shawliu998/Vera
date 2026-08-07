import assert from "node:assert/strict";
import test from "node:test";

import {
    AgentTaskWordArtifactSaveError,
    assertAgentTaskWordArtifactVersion,
    parseAgentTaskWordArtifactSaveError,
} from "./agentTaskWordArtifactSave";

const version = {
    id: "version-3",
    version_number: 3,
    source: "user_upload",
    created_at: "2026-08-07T00:00:00.000Z",
    filename: "Contract.docx",
};

test("parses only a structured re-verification partial save", () => {
    const error = parseAgentTaskWordArtifactSaveError({
        status: 503,
        body: {
            detail: "The Version was preserved.",
            issue_code: "reverification_unavailable",
            preserved_version: version,
        },
    });
    assert.ok(error instanceof AgentTaskWordArtifactSaveError);
    assert.equal(error.status, 503);
    assert.equal(error.issueCode, "reverification_unavailable");
    assert.equal(error.preservedVersion?.id, "version-3");
});

test("malformed or unrelated errors cannot authorize a preserved save", () => {
    assert.equal(
        parseAgentTaskWordArtifactSaveError({
            status: 409,
            body: {
                detail: "Conflict",
                issue_code: "version_conflict",
                preserved_version: version,
            },
        }),
        null,
    );
    const malformed = parseAgentTaskWordArtifactSaveError({
        status: 503,
        body: {
            detail: "The Version was preserved.",
            issue_code: "reverification_unavailable",
            preserved_version: { ...version, id: "" },
        },
    });
    assert.ok(malformed instanceof AgentTaskWordArtifactSaveError);
    assert.equal(malformed.preservedVersion, null);
});

test("a successful Task save requires the server re-verification receipt", () => {
    assert.equal(
        assertAgentTaskWordArtifactVersion({
            ...version,
            artifact_reverification: {
                outcome: "started",
                task_status: "verifying",
                current_step: "verify-deliverables",
            },
        }).artifact_reverification.outcome,
        "started",
    );
    assert.throws(
        () => assertAgentTaskWordArtifactVersion(version),
        /without a valid re-verification receipt/,
    );
});
