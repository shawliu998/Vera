export const WORD_TASK_ARTIFACT_BINDING_COUNT = "VeraTaskArtifactBindingCount";
export const WORD_TASK_ARTIFACT_BINDING_PREFIX = "VeraTaskArtifactBinding";
export const WORD_TASK_ARTIFACT_BINDING_KIND = "agent-task-word-artifact-v1";

const CUSTOM_PROPERTY_CHUNK_LENGTH = 200;
const RAW_UUID_HEX = /^[0-9a-f]{32}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type WordTaskArtifactBinding = {
    schemaVersion: 1;
    kind: typeof WORD_TASK_ARTIFACT_BINDING_KIND;
    taskId: string;
    projectId: string;
    deliverableKey: string;
    documentId: string;
    versionId: string;
};

export type WordTaskArtifactBindingClassification =
    | { kind: "absent" }
    | { kind: "invalid" }
    | { kind: "bound"; binding: WordTaskArtifactBinding };

export type WordTaskArtifactBindingCustomProperty = {
    name: string;
    value: string;
};

export class WordTaskArtifactOpenIdentityError extends Error {
    constructor() {
        super(
            "The current document is not this Task's current Word artifact. Reopen it from Vera.",
        );
        this.name = "WordTaskArtifactOpenIdentityError";
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function canonicalUuidIdentity(value: string): string | null {
    const raw = RAW_UUID_HEX.test(value)
        ? value.toLowerCase()
        : CANONICAL_UUID.test(value)
          ? value.replaceAll("-", "").toLowerCase()
          : null;
    if (!raw) return null;
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function samePersistedIdentity(left: string, right: string): boolean {
    if (left === right) return true;
    const canonicalLeft = canonicalUuidIdentity(left);
    const canonicalRight = canonicalUuidIdentity(right);
    return (
        canonicalLeft !== null &&
        canonicalRight !== null &&
        canonicalLeft === canonicalRight
    );
}

function isWordTaskArtifactBinding(
    value: unknown,
): value is WordTaskArtifactBinding {
    if (!value || typeof value !== "object") return false;
    const binding = value as Partial<WordTaskArtifactBinding>;
    return (
        binding.schemaVersion === 1 &&
        binding.kind === WORD_TASK_ARTIFACT_BINDING_KIND &&
        isNonEmptyString(binding.taskId) &&
        isNonEmptyString(binding.projectId) &&
        isNonEmptyString(binding.deliverableKey) &&
        isNonEmptyString(binding.documentId) &&
        isNonEmptyString(binding.versionId)
    );
}

function canonicalizeBinding(
    binding: WordTaskArtifactBinding,
): WordTaskArtifactBinding {
    return {
        ...binding,
        taskId: canonicalUuidIdentity(binding.taskId) ?? binding.taskId,
        projectId: canonicalUuidIdentity(binding.projectId) ?? binding.projectId,
        documentId:
            canonicalUuidIdentity(binding.documentId) ?? binding.documentId,
        versionId: canonicalUuidIdentity(binding.versionId) ?? binding.versionId,
    };
}

export function encodeWordTaskArtifactBinding(
    binding: WordTaskArtifactBinding,
): WordTaskArtifactBindingCustomProperty[] {
    const serialized = JSON.stringify(binding).replace(
        /\s/g,
        (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const characters = Array.from(serialized);
    const chunks: string[] = [];
    for (
        let offset = 0;
        offset < characters.length;
        offset += CUSTOM_PROPERTY_CHUNK_LENGTH
    ) {
        chunks.push(
            characters
                .slice(offset, offset + CUSTOM_PROPERTY_CHUNK_LENGTH)
                .join(""),
        );
    }
    return [
        { name: WORD_TASK_ARTIFACT_BINDING_COUNT, value: String(chunks.length) },
        ...chunks.map((value, index) => ({
            name: `${WORD_TASK_ARTIFACT_BINDING_PREFIX}${String(index + 1).padStart(3, "0")}`,
            value,
        })),
    ];
}

export function decodeWordTaskArtifactBinding(
    properties: Readonly<Record<string, string>>,
): WordTaskArtifactBinding | null {
    const count = Number(properties[WORD_TASK_ARTIFACT_BINDING_COUNT]);
    if (!Number.isInteger(count) || count < 1 || count > 20) return null;
    const chunks: string[] = [];
    for (let index = 1; index <= count; index += 1) {
        const chunk =
            properties[
                `${WORD_TASK_ARTIFACT_BINDING_PREFIX}${String(index).padStart(3, "0")}`
            ];
        if (typeof chunk !== "string") return null;
        chunks.push(chunk);
    }
    try {
        const value: unknown = JSON.parse(chunks.join(""));
        return isWordTaskArtifactBinding(value)
            ? canonicalizeBinding(value)
            : null;
    } catch {
        return null;
    }
}

export function classifyWordTaskArtifactBinding(
    properties: Readonly<Record<string, string>>,
): WordTaskArtifactBindingClassification {
    const hasBindingProperty = Object.keys(properties).some((name) =>
        name.startsWith(WORD_TASK_ARTIFACT_BINDING_PREFIX),
    );
    if (!hasBindingProperty) return { kind: "absent" };
    const binding = decodeWordTaskArtifactBinding(properties);
    return binding ? { kind: "bound", binding } : { kind: "invalid" };
}

export function assertWordTaskArtifactOpenBinding(
    binding: WordTaskArtifactBinding | null | undefined,
    expected: {
        taskId: string;
        projectId: string;
        deliverableKey: string;
        documentId: string;
        versionId: string;
    },
): WordTaskArtifactBinding {
    if (
        !isWordTaskArtifactBinding(binding) ||
        binding.deliverableKey !== expected.deliverableKey ||
        !samePersistedIdentity(binding.taskId, expected.taskId) ||
        !samePersistedIdentity(binding.projectId, expected.projectId) ||
        !samePersistedIdentity(binding.documentId, expected.documentId) ||
        !samePersistedIdentity(binding.versionId, expected.versionId)
    ) {
        throw new WordTaskArtifactOpenIdentityError();
    }
    return binding;
}

export function successorWordTaskArtifactBinding(
    binding: WordTaskArtifactBinding,
    versionId: string,
): WordTaskArtifactBinding {
    if (!isNonEmptyString(versionId)) {
        throw new Error("The server did not return a Version identity.");
    }
    return { ...binding, versionId };
}

export function assertWordTaskArtifactServerBinding(
    binding: WordTaskArtifactBinding,
    snapshot: {
        task: {
            id: string;
            matter_id: string;
            deliverables: Array<{
                key: string;
                title: string;
                required: boolean;
                artifact_type?: string;
                purpose?: string;
            }>;
        };
        artifacts: Array<{
            artifact_type: string;
            artifact_id: string;
            purpose: string;
        }>;
    },
): WordTaskArtifactBinding {
    const deliverable = snapshot.task.deliverables.find(
        (candidate) =>
            candidate.required !== false &&
            candidate.key === binding.deliverableKey,
    );
    const purpose = deliverable?.purpose?.trim() || deliverable?.title?.trim();
    const artifact = purpose
        ? [...snapshot.artifacts]
              .reverse()
              .find(
                  (candidate) =>
                      candidate.artifact_type === "draft" &&
                      candidate.purpose === purpose &&
                      samePersistedIdentity(
                          candidate.artifact_id,
                          binding.documentId,
                      ),
              )
        : null;
    if (
        !samePersistedIdentity(snapshot.task.id, binding.taskId) ||
        !samePersistedIdentity(snapshot.task.matter_id, binding.projectId) ||
        !deliverable ||
        deliverable.artifact_type !== "draft" ||
        !artifact
    ) {
        throw new WordTaskArtifactOpenIdentityError();
    }
    return binding;
}
