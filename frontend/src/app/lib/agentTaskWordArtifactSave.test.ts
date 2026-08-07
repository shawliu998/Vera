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
    assert.equal(error.reverificationIssue, null);
});

test("parses a server-owned legacy Task recovery action", () => {
    const error = parseAgentTaskWordArtifactSaveError({
        status: 409,
        body: {
            detail: "The Version was preserved.",
            issue_code: "reverification_conflict",
            preserved_version: version,
            reverification_issue: {
                issue_code: "capability_grant_invalid",
                recovery_action: "start_new_task",
                detail: "Start a new Work Task from the same Matter and sources.",
            },
        },
    });
    assert.ok(error instanceof AgentTaskWordArtifactSaveError);
    assert.deepEqual(error.reverificationIssue, {
        issueCode: "capability_grant_invalid",
        recoveryAction: "start_new_task",
        detail: "Start a new Work Task from the same Matter and sources.",
    });
});

test("a present malformed recovery issue cannot authorize a preserved save", () => {
    for (const reverificationIssue of [
        {},
        {
            issue_code: "capability_grant_invalid",
            recovery_action: "start_new_task",
            detail: "",
        },
        {
            issue_code: "unknown_issue",
            recovery_action: "start_new_task",
            detail: "Start a new Work Task.",
        },
        {
            issue_code: "capability_grant_invalid",
            recovery_action: "retry",
            detail: "Start a new Work Task.",
        },
    ]) {
        assert.equal(
            parseAgentTaskWordArtifactSaveError({
                status: 409,
                body: {
                    detail: "The Version was preserved.",
                    issue_code: "reverification_conflict",
                    preserved_version: version,
                    reverification_issue: reverificationIssue,
                },
            }),
            null,
        );
    }
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
