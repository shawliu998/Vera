import { chmodSync, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import SignalDatabase from "@signalapp/sqlcipher";
import { databaseEncryptionMode } from "./localEnvelopeCrypto";
import {
  loadLocalDatabaseKey,
  localDatabaseKeyId,
  localDatabaseKeySource,
} from "./localDatabaseKey";

type DatabaseDriver = "node:sqlite" | "signal-sqlcipher";

export type LocalDatabaseOptions = {
  readOnly?: boolean;
};

function normalizeSignalParameters(parameters: unknown[]) {
  if (parameters.length === 0) return undefined;
  if (parameters.length === 1) {
    const value = parameters[0];
    if (Array.isArray(value)) return value;
    if (
      value !== null &&
      typeof value === "object" &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uint8Array)
    ) {
      return value;
    }
    return [value];
  }
  return parameters;
}

class LocalStatement {
  constructor(
    private readonly driver: DatabaseDriver,
    private readonly statement: any,
  ) {}

  run(...parameters: unknown[]): any {
    if (this.driver === "node:sqlite") return this.statement.run(...parameters);
    const normalized = normalizeSignalParameters(parameters);
    return normalized === undefined
      ? this.statement.run()
      : this.statement.run(normalized);
  }

  get(...parameters: unknown[]): any {
    if (this.driver === "node:sqlite") return this.statement.get(...parameters);
    const normalized = normalizeSignalParameters(parameters);
    return normalized === undefined
      ? this.statement.get()
      : this.statement.get(normalized);
  }

  all(...parameters: unknown[]): any[] {
    if (this.driver === "node:sqlite") return this.statement.all(...parameters);
    const normalized = normalizeSignalParameters(parameters);
    return normalized === undefined
      ? this.statement.all()
      : this.statement.all(normalized);
  }
}

export class LocalDatabase {
  readonly driver: DatabaseDriver;
  readonly cipherVersion: string | null;
  readonly cipherProvider: string | null;
  readonly keyId: string | null;
  private readonly database: any;

  constructor(
    readonly databasePath: string,
    options: LocalDatabaseOptions = {},
  ) {
    if (databaseEncryptionMode() === "metadata_plaintext") {
      this.driver = "node:sqlite";
      this.cipherVersion = null;
      this.cipherProvider = null;
      this.keyId = null;
      this.database = new DatabaseSync(databasePath, {
        readOnly: options.readOnly ?? false,
      });
      return;
    }

    if (options.readOnly && !existsSync(databasePath)) {
      throw new Error(`SQLCipher database does not exist: ${databasePath}`);
    }
    const existingDatabase =
      databasePath !== ":memory:" &&
      existsSync(databasePath) &&
      statSync(databasePath).size > 0;
    const key = loadLocalDatabaseKey();
    const database = new SignalDatabase(databasePath);
    try {
      database.pragma(`key = "x'${key.toString("hex")}'"`);
      const cipherVersion = database.pragma("cipher_version", {
        simple: true,
      });
      const cipherProvider = database.pragma("cipher_provider", {
        simple: true,
      });
      if (typeof cipherVersion !== "string" || !cipherVersion.trim()) {
        throw new Error(
          "@signalapp/sqlcipher did not report a non-empty cipher_version.",
        );
      }
      database.prepare("select count(*) as count from sqlite_master").get();
      if (existingDatabase) {
        const integrity = database.pragma("cipher_integrity_check");
        if (!Array.isArray(integrity) || integrity.length !== 0) {
          throw new Error(
            `SQLCipher integrity check failed: ${JSON.stringify(integrity)}`,
          );
        }
      }
      if (options.readOnly) database.exec("PRAGMA query_only = ON");
      this.database = database;
      this.driver = "signal-sqlcipher";
      this.cipherVersion = cipherVersion;
      this.cipherProvider =
        typeof cipherProvider === "string" ? cipherProvider : null;
      this.keyId = localDatabaseKeyId(key);
      if (databasePath !== ":memory:" && existsSync(databasePath)) {
        chmodSync(databasePath, 0o600);
      }
    } catch (error) {
      database.close();
      throw new Error(
        `Unable to open the required SQLCipher database. Verify the dedicated database key or run the offline plaintext migration first. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  prepare(sql: string) {
    return new LocalStatement(this.driver, this.database.prepare(sql));
  }

  close() {
    this.database.close();
  }

  status() {
    return {
      driver: this.driver,
      encrypted: this.driver === "signal-sqlcipher",
      cipher_version: this.cipherVersion,
      cipher_provider: this.cipherProvider,
      key_id: this.keyId,
      key_source:
        this.driver === "signal-sqlcipher" ? localDatabaseKeySource() : "none",
    };
  }
}

export function verifySqlcipherRuntime() {
  const database = new LocalDatabase(":memory:");
  try {
    const status = database.status();
    if (!status.encrypted || !status.cipher_version) {
      throw new Error(
        "SQLCipher runtime verification did not activate encryption.",
      );
    }
    return status;
  } finally {
    database.close();
  }
}
