import { INITIAL_WORKSPACE_MIGRATION } from "./v1InitialWorkspace";
import { WORKSPACE_INTEGRITY_MIGRATION } from "./v2WorkspaceIntegrity";
import { WORKSPACE_RUNTIME_MIGRATION } from "./v3WorkspaceRuntime";
import { PROJECT_OWNERSHIP_MIGRATION } from "./v4ProjectOwnership";
import { ASSISTANT_RUNTIME_MIGRATION } from "./v5AssistantRuntime";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "./v6WorkflowRuntime";
import { TABULAR_MIKE_SEMANTICS_V7_MIGRATION } from "./v7TabularMikeSemantics";
import { MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION } from "./v8ModelCredentialOrigin";
import { MODEL_CONNECTION_READINESS_V9_MIGRATION } from "./v9ModelConnectionReadiness";
import { ASSISTANT_DURABLE_EVENTS_V10_MIGRATION } from "./v10AssistantDurableEvents";
import { PROJECT_SOURCE_FOUNDATION_V11_MIGRATION } from "./v11ProjectSourceFoundation";
import { DOCUMENT_STUDIO_V12_MIGRATION } from "./v12DocumentStudio";
import { SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION } from "./v13SourceRetentionLifecycle";
import { DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION } from "./v14DocumentStudioSuggestions";
import { MATTER_PROFILES_V15_MIGRATION } from "./v15MatterProfiles";
import { MATTER_CLASSIFICATION_V16_MIGRATION } from "./v16MatterClassification";

export {
  detectWorkspaceDatabaseCapabilities,
  runWorkspaceMigrations,
  workspaceMigrationChecksum,
  WorkspaceMigrationError,
} from "./runner";
export type {
  AppliedWorkspaceMigration,
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
  WorkspaceMigrationRun,
  WorkspaceStatement,
} from "./types";
export { INITIAL_WORKSPACE_MIGRATION } from "./v1InitialWorkspace";
export { WORKSPACE_INTEGRITY_MIGRATION } from "./v2WorkspaceIntegrity";
export { WORKSPACE_RUNTIME_MIGRATION } from "./v3WorkspaceRuntime";
export { PROJECT_OWNERSHIP_MIGRATION } from "./v4ProjectOwnership";
export { ASSISTANT_RUNTIME_MIGRATION } from "./v5AssistantRuntime";
export { WORKFLOW_RUNTIME_V6_MIGRATION } from "./v6WorkflowRuntime";
export { TABULAR_MIKE_SEMANTICS_V7_MIGRATION } from "./v7TabularMikeSemantics";
export { MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION } from "./v8ModelCredentialOrigin";
export { MODEL_CONNECTION_READINESS_V9_MIGRATION } from "./v9ModelConnectionReadiness";
export { ASSISTANT_DURABLE_EVENTS_V10_MIGRATION } from "./v10AssistantDurableEvents";
export { PROJECT_SOURCE_FOUNDATION_V11_MIGRATION } from "./v11ProjectSourceFoundation";
export { DOCUMENT_STUDIO_V12_MIGRATION } from "./v12DocumentStudio";
export { SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION } from "./v13SourceRetentionLifecycle";
export { DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION } from "./v14DocumentStudioSuggestions";
export { MATTER_PROFILES_V15_MIGRATION } from "./v15MatterProfiles";
export { MATTER_CLASSIFICATION_V16_MIGRATION } from "./v16MatterClassification";

export const WORKSPACE_MIGRATIONS = [
  INITIAL_WORKSPACE_MIGRATION,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_RUNTIME_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
  ASSISTANT_RUNTIME_MIGRATION,
  WORKFLOW_RUNTIME_V6_MIGRATION,
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
  MODEL_CONNECTION_READINESS_V9_MIGRATION,
  ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
  PROJECT_SOURCE_FOUNDATION_V11_MIGRATION,
  DOCUMENT_STUDIO_V12_MIGRATION,
  SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION,
  DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION,
  MATTER_PROFILES_V15_MIGRATION,
  MATTER_CLASSIFICATION_V16_MIGRATION,
] as const;
