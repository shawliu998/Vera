import {
  LocalDatabase,
  type LocalDatabaseOptions,
} from "../aletheia/localDatabase";
import {
  runWorkspaceMigrations,
  WORKSPACE_MIGRATIONS,
  type WorkspaceMigration,
  type WorkspaceMigrationRun,
} from "./migrations";

export type WorkspaceDatabaseOptions = LocalDatabaseOptions & {
  migrations?: readonly WorkspaceMigration[];
  migrate?: boolean;
};

/**
 * Workspace persistence uses the existing verified SQLite/SQLCipher adapter.
 * It never selects a weaker driver: LocalDatabase remains responsible for the
 * fail-closed encryption mode and key checks configured for the application.
 */
export class WorkspaceDatabase {
  private readonly database: LocalDatabase;
  readonly migration: WorkspaceMigrationRun | null;

  constructor(
    readonly databasePath: string,
    options: WorkspaceDatabaseOptions = {},
  ) {
    this.database = new LocalDatabase(databasePath, {
      readOnly: options.readOnly,
    });
    try {
      this.migration =
        options.migrate === false || options.readOnly
          ? null
          : runWorkspaceMigrations(
              this.database,
              options.migrations ?? WORKSPACE_MIGRATIONS,
            );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  exec(sql: string) {
    return this.database.exec(sql);
  }

  prepare(sql: string) {
    return this.database.prepare(sql);
  }

  status() {
    return this.database.status();
  }

  close() {
    this.database.close();
  }
}

export {
  runWorkspaceMigrations,
  WORKSPACE_MIGRATIONS,
  WorkspaceMigrationError,
  workspaceMigrationChecksum,
} from "./migrations";
export type {
  AppliedWorkspaceMigration,
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
  WorkspaceMigrationRun,
} from "./migrations";
