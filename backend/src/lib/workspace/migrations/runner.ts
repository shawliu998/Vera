import { createHash } from "node:crypto";
import type {
  AppliedWorkspaceMigration,
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
  WorkspaceMigrationRun,
} from "./types";

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS workspace_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  checksum TEXT NOT NULL
    CHECK (length(checksum) = 71 AND checksum GLOB 'sha256:*' AND substr(checksum, 8) NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export class WorkspaceMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceMigrationError";
  }
}

function firstValue(row: Record<string, unknown> | undefined) {
  return row ? Object.values(row)[0] : undefined;
}

function assertForeignKeysEnabled(database: WorkspaceDatabaseAdapter) {
  database.exec("PRAGMA foreign_keys = ON");
  const enabled = Number(
    firstValue(database.prepare("PRAGMA foreign_keys").get()),
  );
  if (enabled !== 1) {
    throw new WorkspaceMigrationError(
      "Workspace migrations require SQLite foreign_keys enforcement.",
    );
  }
}

function assertDatabaseIntegrity(database: WorkspaceDatabaseAdapter) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  if (
    integrityRows.length !== 1 ||
    String(firstValue(integrityRows[0])) !== "ok"
  ) {
    throw new WorkspaceMigrationError(
      `Workspace database integrity_check failed: ${JSON.stringify(integrityRows)}`,
    );
  }
  const foreignKeyViolations = database
    .prepare("PRAGMA foreign_key_check")
    .all();
  if (foreignKeyViolations.length !== 0) {
    throw new WorkspaceMigrationError(
      `Workspace database foreign_key_check failed: ${JSON.stringify(foreignKeyViolations)}`,
    );
  }
}

function supportsJsonTextChecks(database: WorkspaceDatabaseAdapter) {
  try {
    return (
      Number(
        firstValue(
          database
            .prepare("SELECT json_valid('{\"workspace\":true}') AS valid")
            .get(),
        ),
      ) === 1
    );
  } catch {
    return false;
  }
}

function supportsFts5(database: WorkspaceDatabaseAdapter) {
  const probeName = "workspace_fts5_capability_probe";
  try {
    database.exec(
      `CREATE VIRTUAL TABLE temp.${probeName} USING fts5(content); DROP TABLE temp.${probeName};`,
    );
    return true;
  } catch {
    try {
      database.exec(`DROP TABLE IF EXISTS temp.${probeName}`);
    } catch {
      // The adapter rejected FTS5 before creating the temporary probe table.
    }
    return false;
  }
}

export function detectWorkspaceDatabaseCapabilities(
  database: WorkspaceDatabaseAdapter,
): WorkspaceDatabaseCapabilities {
  return {
    jsonTextChecks: supportsJsonTextChecks(database),
    fts5: supportsFts5(database),
  };
}

export function workspaceMigrationChecksum(migration: WorkspaceMigration) {
  return `sha256:${createHash("sha256")
    .update(
      [
        String(migration.version),
        migration.name,
        migration.checksumMaterial,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")}`;
}

function validateMigrationRegistry(migrations: readonly WorkspaceMigration[]) {
  let previousVersion = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new WorkspaceMigrationError(
        `Workspace migration version must be a positive safe integer: ${migration.version}`,
      );
    }
    if (migration.version <= previousVersion) {
      throw new WorkspaceMigrationError(
        "Workspace migrations must be registered in strictly increasing version order.",
      );
    }
    if (!migration.name.trim() || names.has(migration.name)) {
      throw new WorkspaceMigrationError(
        `Workspace migration name is empty or duplicated: ${migration.name}`,
      );
    }
    if (!migration.checksumMaterial) {
      throw new WorkspaceMigrationError(
        `Workspace migration ${migration.version} has no checksum material.`,
      );
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

function loadAppliedMigrations(database: WorkspaceDatabaseAdapter) {
  return database
    .prepare(
      `SELECT version, name, checksum, applied_at
         FROM workspace_schema_migrations
        ORDER BY version ASC`,
    )
    .all()
    .map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appliedAt: String(row.applied_at),
    }));
}

function assertAppliedMigrationsMatch(
  applied: AppliedWorkspaceMigration[],
  migrations: readonly WorkspaceMigration[],
) {
  for (let index = 0; index < applied.length; index += 1) {
    const record = applied[index];
    const migration = migrations[index];
    if (!migration || migration.version !== record.version) {
      throw new WorkspaceMigrationError(
        `Workspace database contains unknown or out-of-order migration version ${record.version}.`,
      );
    }
    if (migration.name !== record.name) {
      throw new WorkspaceMigrationError(
        `Workspace migration ${record.version} name drift: expected ${migration.name}, found ${record.name}.`,
      );
    }
    const expectedChecksum = workspaceMigrationChecksum(migration);
    if (expectedChecksum !== record.checksum) {
      throw new WorkspaceMigrationError(
        `Workspace migration ${record.version} checksum drift: expected ${expectedChecksum}, found ${record.checksum}.`,
      );
    }
  }
}

function inImmediateTransaction<T>(
  database: WorkspaceDatabaseAdapter,
  operation: () => T,
) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure as the primary error.
    }
    throw error;
  }
}

export function runWorkspaceMigrations(
  database: WorkspaceDatabaseAdapter,
  migrations: readonly WorkspaceMigration[],
): WorkspaceMigrationRun {
  validateMigrationRegistry(migrations);
  assertForeignKeysEnabled(database);
  assertDatabaseIntegrity(database);
  const capabilities = detectWorkspaceDatabaseCapabilities(database);

  inImmediateTransaction(database, () => {
    database.exec(MIGRATION_TABLE_SQL);
  });

  const existing = loadAppliedMigrations(database);
  assertAppliedMigrationsMatch(existing, migrations);
  const newlyApplied: AppliedWorkspaceMigration[] = [];

  for (const migration of migrations.slice(existing.length)) {
    const checksum = workspaceMigrationChecksum(migration);
    try {
      const applied = inImmediateTransaction(database, () => {
        migration.apply(database, capabilities);
        const violations = database.prepare("PRAGMA foreign_key_check").all();
        if (violations.length !== 0) {
          throw new WorkspaceMigrationError(
            `Workspace migration ${migration.version} introduced foreign-key violations: ${JSON.stringify(violations)}`,
          );
        }
        database
          .prepare(
            `INSERT INTO workspace_schema_migrations (version, name, checksum)
             VALUES (?, ?, ?)`,
          )
          .run(migration.version, migration.name, checksum);
        const row = database
          .prepare(
            `SELECT version, name, checksum, applied_at
               FROM workspace_schema_migrations WHERE version = ?`,
          )
          .get(migration.version);
        if (!row) {
          throw new WorkspaceMigrationError(
            `Workspace migration ${migration.version} was not recorded.`,
          );
        }
        return {
          version: Number(row.version),
          name: String(row.name),
          checksum: String(row.checksum),
          appliedAt: String(row.applied_at),
        };
      });
      newlyApplied.push(applied);
    } catch (error) {
      if (error instanceof WorkspaceMigrationError) throw error;
      throw new WorkspaceMigrationError(
        `Workspace migration ${migration.version} (${migration.name}) failed and was rolled back.`,
        { cause: error },
      );
    }
  }

  assertDatabaseIntegrity(database);
  const allApplied = loadAppliedMigrations(database);
  assertAppliedMigrationsMatch(allApplied, migrations);
  return {
    applied: newlyApplied,
    currentVersion: allApplied.at(-1)?.version ?? 0,
    capabilities,
    preflight: {
      foreignKeysEnabled: true,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
    },
  };
}
