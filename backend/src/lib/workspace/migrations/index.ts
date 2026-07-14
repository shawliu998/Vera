import { INITIAL_WORKSPACE_MIGRATION } from "./v1InitialWorkspace";
import { WORKSPACE_INTEGRITY_MIGRATION } from "./v2WorkspaceIntegrity";
import { WORKSPACE_RUNTIME_MIGRATION } from "./v3WorkspaceRuntime";
import { PROJECT_OWNERSHIP_MIGRATION } from "./v4ProjectOwnership";
import { ASSISTANT_RUNTIME_MIGRATION } from "./v5AssistantRuntime";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "./v6WorkflowRuntime";
import { TABULAR_MIKE_SEMANTICS_V7_MIGRATION } from "./v7TabularMikeSemantics";
import { MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION } from "./v8ModelCredentialOrigin";

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

export const WORKSPACE_MIGRATIONS = [
  INITIAL_WORKSPACE_MIGRATION,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_RUNTIME_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
  ASSISTANT_RUNTIME_MIGRATION,
  WORKFLOW_RUNTIME_V6_MIGRATION,
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
] as const;
