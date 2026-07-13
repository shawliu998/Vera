#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const desktopDir = path.resolve(__dirname, "..");
const backendDir = path.resolve(desktopDir, "..", "backend");
const migrationEntry = path.join(backendDir, "dist", "desktopMigrate.js");
const electronPath = require("electron");
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "aletheia-migration-audit-"),
);
const dataDir = path.join(root, "data");
const backupDir = path.join(root, "backup");
const databasePath = path.join(dataDir, "aletheia.db");
const documentPath = path.join(dataDir, "documents", "evidence.txt");
const sqliteHeader = Buffer.from("SQLite format 3\0", "utf8");
const envelopeHeader = Buffer.from("ALETHEIAENC\0", "ascii");
const masterKey = crypto.randomBytes(32).toString("base64");
const databaseKey = crypto.randomBytes(32).toString("base64");

function runMigration() {
  const result = spawnSync(electronPath, [migrationEntry], {
    cwd: backendDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ALETHEIA_DATA_DIR: dataDir,
      ALETHEIA_DESKTOP_MIGRATION_BACKUP_DIR: backupDir,
      ALETHEIA_APPLICATION_ENCRYPTION: "required",
      ALETHEIA_MASTER_KEY_SOURCE: "env",
      ALETHEIA_MASTER_KEY_BASE64: masterKey,
      ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      ALETHEIA_DATABASE_KEY_SOURCE: "env",
      ALETHEIA_DATABASE_KEY_BASE64: databaseKey,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

try {
  fs.mkdirSync(path.dirname(documentPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  database.exec(
    "create table matters (id text primary key, title text not null)",
  );
  database
    .prepare("insert into matters values (?, ?)")
    .run("matter-1", "Migration fixture");
  database.close();
  fs.writeFileSync(documentPath, "legacy evidence", { mode: 0o600 });

  const first = runMigration();
  assert.equal(first.database.status, "migrated");
  assert.equal(first.files.encrypted, 1);
  assert.equal(
    fs
      .readFileSync(databasePath)
      .subarray(0, sqliteHeader.length)
      .equals(sqliteHeader),
    false,
  );
  assert.equal(
    fs
      .readFileSync(documentPath)
      .subarray(0, envelopeHeader.length)
      .equals(envelopeHeader),
    true,
  );
  assert.equal(fs.existsSync(backupDir), false);

  const second = runMigration();
  assert.equal(second.database.status, "already_encrypted");
  assert.equal(second.files.already_encrypted, 1);
  assert.equal(fs.existsSync(backupDir), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "aletheia-desktop-legacy-migration-v1",
        checks: [
          "plaintext SQLite migrated to verified SQLCipher",
          "legacy document migrated to authenticated envelope",
          "successful migration removes temporary plaintext backup",
          "second migration run is idempotent",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
