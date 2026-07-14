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
      // Workspace and Legacy repositories intentionally share the same
      // aletheia.db file through separate handles. Configure every Workspace
      // handle before migrations or repository work so concurrent desktop
      // activity waits briefly instead of failing immediately, and so all
      // connections enforce the same foreign-key boundary.
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      if (!options.readOnly) {
        this.database.exec("PRAGMA journal_mode = WAL");
      }
      this.migration =
        options.migrate === false || options.readOnly
          ? null
          : this.runMigrations(options.migrations ?? WORKSPACE_MIGRATIONS);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  runMigrations(
    migrations: readonly WorkspaceMigration[] = WORKSPACE_MIGRATIONS,
  ) {
    return runWorkspaceMigrations(this.database, migrations);
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
