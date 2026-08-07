import assert from "node:assert/strict";
import test from "node:test";

import {
    assertWordTaskArtifactOpenBinding,
    assertWordTaskArtifactServerBinding,
    classifyWordTaskArtifactBinding,
    decodeWordTaskArtifactBinding,
    encodeWordTaskArtifactBinding,
    successorWordTaskArtifactBinding,
    WordTaskArtifactOpenIdentityError,
    type WordTaskArtifactBinding,
} from "./wordTaskArtifactBinding";

const binding: WordTaskArtifactBinding = {
    schemaVersion: 1,
    kind: "agent-task-word-artifact-v1",
    taskId: "a0d75d08-c1a0-4a3f-afb3-4c16d5141615",
    projectId: "0ebafd84-1f05-4a5a-b90c-fe992434e6ee",
    deliverableKey: "claim-comparison-memo",
    documentId: "0ff133ee-4208-80f8-fdf9-3bf5a94331da",
    versionId: "8d3f5df3-c172-f4c6-6857-ad1847aa57e0",
};

function propertiesFor(value = binding) {
    return Object.fromEntries(
        encodeWordTaskArtifactBinding(value).map(({ name, value }) => [
            name,
            value,
        ]),
    );
}

test("Task Word artifact binding round-trips within the Word property limit", () => {
    const encoded = encodeWordTaskArtifactBinding(binding);
    assert.ok(encoded.every((property) => property.value.length <= 200));
    assert.deepEqual(decodeWordTaskArtifactBinding(propertiesFor()), binding);
    assert.deepEqual(classifyWordTaskArtifactBinding(propertiesFor()), {
        kind: "bound",
        binding,
    });
    assert.deepEqual(classifyWordTaskArtifactBinding({}), { kind: "absent" });
    assert.deepEqual(
        classifyWordTaskArtifactBinding({ VeraTaskArtifactBindingCount: "2" }),
        { kind: "invalid" },
    );
});

test("Task Word artifact binding validates the declared Task draft", () => {
    const snapshot = {
        task: {
            id: binding.taskId,
            matter_id: binding.projectId,
            deliverables: [
                {
                    key: binding.deliverableKey,
                    title: "Claim comparison memorandum",
                    required: true,
                    artifact_type: "draft",
                    purpose: "Claim comparison memorandum",
                },
            ],
        },
        artifacts: [
            {
                artifact_type: "draft",
                artifact_id: binding.documentId,
                purpose: "Claim comparison memorandum",
            },
        ],
    };
    assert.equal(assertWordTaskArtifactServerBinding(binding, snapshot), binding);
    assert.throws(
        () =>
            assertWordTaskArtifactServerBinding(binding, {
                ...snapshot,
                artifacts: [
                    { ...snapshot.artifacts[0], artifact_id: "other-doc" },
                ],
            }),
        WordTaskArtifactOpenIdentityError,
    );
});

test("Task Word artifact binding requires the exact open document Version and advances once", () => {
    assert.equal(
        assertWordTaskArtifactOpenBinding(binding, {
            taskId: binding.taskId,
            projectId: binding.projectId,
            deliverableKey: binding.deliverableKey,
            documentId: binding.documentId,
            versionId: binding.versionId,
        }),
        binding,
    );
    assert.throws(
        () =>
            assertWordTaskArtifactOpenBinding(binding, {
                taskId: binding.taskId,
                projectId: binding.projectId,
                deliverableKey: binding.deliverableKey,
                documentId: binding.documentId,
                versionId: "newer-version",
            }),
        WordTaskArtifactOpenIdentityError,
    );
    assert.deepEqual(successorWordTaskArtifactBinding(binding, "version-2"), {
        ...binding,
        versionId: "version-2",
    });
});

test("Task Word artifact binding treats raw and canonical UUIDs as the same persisted identity", () => {
    const raw = binding.taskId.replaceAll("-", "");
    assert.equal(
        assertWordTaskArtifactOpenBinding(
            { ...binding, taskId: raw },
            {
                taskId: binding.taskId,
                projectId: binding.projectId,
                deliverableKey: binding.deliverableKey,
                documentId: binding.documentId,
                versionId: binding.versionId,
            },
        ).taskId,
        raw,
    );
});
