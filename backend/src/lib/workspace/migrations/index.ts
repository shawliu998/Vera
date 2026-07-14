import { INITIAL_WORKSPACE_MIGRATION } from "./v1InitialWorkspace";

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

export const WORKSPACE_MIGRATIONS = [INITIAL_WORKSPACE_MIGRATION] as const;
