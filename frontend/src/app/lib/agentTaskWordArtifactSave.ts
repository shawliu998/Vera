import type { DocumentVersion } from "./mikeApi";

export type AgentTaskWordArtifactReverification = {
    outcome: "started" | "already_started";
    task_status: string | null;
    current_step: string | null;
};

export type AgentTaskWordArtifactVersion = DocumentVersion & {
    artifact_reverification: AgentTaskWordArtifactReverification;
};

export type AgentTaskWordArtifactSaveIssueCode =
    "reverification_conflict" | "reverification_unavailable";

export class AgentTaskWordArtifactSaveError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly issueCode: AgentTaskWordArtifactSaveIssueCode,
        public readonly preservedVersion: DocumentVersion | null,
    ) {
        super(message);
        this.name = "AgentTaskWordArtifactSaveError";
    }
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function parsePreservedVersion(value: unknown): DocumentVersion | null {
    if (!value || typeof value !== "object") return null;
    const version = value as Partial<DocumentVersion>;
    if (
        typeof version.id !== "string" ||
        !version.id.trim() ||
        !(
            version.version_number === null ||
            (typeof version.version_number === "number" &&
                Number.isSafeInteger(version.version_number) &&
                version.version_number > 0)
        ) ||
        typeof version.source !== "string" ||
        !version.source.trim() ||
        typeof version.created_at !== "string" ||
        !version.created_at.trim() ||
        !isNullableString(version.filename)
    ) {
        return null;
    }
    return version as DocumentVersion;
}

export function parseAgentTaskWordArtifactSaveError(args: {
    status: number;
    body: unknown;
}): AgentTaskWordArtifactSaveError | null {
    if (!args.body || typeof args.body !== "object") return null;
    const body = args.body as {
        detail?: unknown;
        issue_code?: unknown;
        preserved_version?: unknown;
    };
    if (
        typeof body.detail !== "string" ||
        !body.detail.trim() ||
        (body.issue_code !== "reverification_conflict" &&
            body.issue_code !== "reverification_unavailable")
    ) {
        return null;
    }
    return new AgentTaskWordArtifactSaveError(
        body.detail,
        args.status,
        body.issue_code,
        parsePreservedVersion(body.preserved_version),
    );
}

export function assertAgentTaskWordArtifactVersion(
    value: DocumentVersion,
): AgentTaskWordArtifactVersion {
    const transition = value.artifact_reverification;
    if (
        !transition ||
        (transition.outcome !== "started" &&
            transition.outcome !== "already_started") ||
        !isNullableString(transition.task_status) ||
        !isNullableString(transition.current_step)
    ) {
        throw new Error(
            "The server saved the Word Version without a valid re-verification receipt.",
        );
    }
    return value as AgentTaskWordArtifactVersion;
}
