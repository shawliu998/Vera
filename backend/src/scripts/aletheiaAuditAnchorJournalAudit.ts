import { strict as assert } from "node:assert";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  AuditAnchorConfigurationError,
  AuditAnchorVerificationError,
  createAuditAnchor,
  exportAuditAnchorVerificationBundle,
  generateAuditAnchorKeyPair,
  auditAnchorRuntimeStatus,
  runAuditAnchorRuntimeNow,
  shouldFailClosedForAuditAnchor,
  startAuditAnchorRuntimeFromEnvironment,
  verifyAuditAnchorJournal,
  verifyAuditAnchorVerificationBundle,
  type AuditAnchorConfig,
} from "../lib/aletheia/auditAnchorJournal";

function expectThrows(fn: () => unknown, type: new (...args: any[]) => Error) {
  assert.throws(fn, (error: unknown) => error instanceof type);
}

const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-anchor-audit-"));
try {
  const dataDir = path.join(root, "vault");
  const anchorDir = path.join(root, "external-anchors");
  const keyDir = path.join(root, "operator-keys");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(anchorDir, { mode: 0o700 });
  mkdirSync(keyDir, { mode: 0o700 });
  const privateKeyPath = path.join(keyDir, "anchor-private.pem");
  const publicKeyPath = path.join(keyDir, "anchor-public.pem");
  const generated = generateAuditAnchorKeyPair({
    dataDir,
    privateKeyPath,
    publicKeyPath,
  });
  const config: AuditAnchorConfig = {
    dataDir,
    anchorDir,
    privateKeyPath,
    publicKeyPath,
  };

  const db = new LocalDatabase(path.join(dataDir, "aletheia.db"));
  db.exec(`
    create table aletheia_matters (id text primary key);
    create table aletheia_audit_events (
      id text primary key,
      matter_id text not null,
      sequence integer,
      event_hash text,
      created_at text not null
    );
    create table aletheia_deletion_tombstones (
      id text primary key,
      matter_id text not null,
      tombstone_hash text not null,
      deleted_at text not null
    );
    insert into aletheia_matters (id) values ('matter-a');
    insert into aletheia_audit_events
      (id, matter_id, sequence, event_hash, created_at)
      values ('event-1', 'matter-a', 1, 'hmac-sha256:event-1', '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  const first = createAuditAnchor(config, "test_first");
  assert.equal(first.anchor_index, 1);
  assert.equal(first.previous_anchor_hash, null);

  const db2 = new LocalDatabase(path.join(dataDir, "aletheia.db"));
  db2.exec(`
    insert into aletheia_audit_events
      (id, matter_id, sequence, event_hash, created_at)
      values ('event-2', 'matter-a', 2, 'hmac-sha256:event-2', '2026-01-02T00:00:00.000Z');
  `);
  db2.close();
  const second = createAuditAnchor({ ...config }, "test_second");
  assert.equal(second.anchor_index, 2);
  assert.equal(second.previous_anchor_hash, first.anchor_hash);

  const db3 = new LocalDatabase(path.join(dataDir, "aletheia.db"));
  db3.exec(`
    insert into aletheia_deletion_tombstones
      (id, matter_id, tombstone_hash, deleted_at)
      values ('tombstone-1', 'matter-deleted', 'hmac-sha256:tombstone-1', '2026-01-03T00:00:00.000Z');
  `);
  db3.close();

  // A fresh config object simulates a process restart and must continue the head.
  const third = createAuditAnchor({ ...config }, "test_restart");
  assert.equal(third.anchor_index, 3);
  assert.equal(third.previous_anchor_hash, second.anchor_hash);
  const verified = verifyAuditAnchorJournal({
    dataDir,
    anchorDir,
    publicKeyPath,
    compareCurrentSnapshot: true,
    expectedHeadHash: third.anchor_hash,
  });
  assert.equal(verified.entries, 3);
  assert.equal(verified.current_snapshot_matches, true);

  const rollbackDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
  rollbackDb
    .prepare("delete from aletheia_audit_events where id = ?")
    .run("event-2");
  rollbackDb.close();
  expectThrows(
    () => createAuditAnchor({ ...config }, "test_database_rollback"),
    AuditAnchorVerificationError,
  );
  const restoreDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
  restoreDb.exec(`
    insert into aletheia_audit_events
      (id, matter_id, sequence, event_hash, created_at)
      values ('event-2', 'matter-a', 2, 'hmac-sha256:event-2', '2026-01-02T00:00:00.000Z');
  `);
  restoreDb.close();

  const journal = readFileSync(
    path.join(anchorDir, "audit-anchors.jsonl"),
    "utf8",
  );
  const originalLines = journal.trimEnd().split("\n");
  function attackJournal(name: string, lines: string[], finalNewline = true) {
    const target = path.join(root, name);
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(
      path.join(target, "audit-anchors.jsonl"),
      `${lines.join("\n")}${finalNewline ? "\n" : ""}`,
      { mode: 0o600 },
    );
    chmodSync(path.join(target, "audit-anchors.jsonl"), 0o600);
    return target;
  }

  const tamperedEntries = originalLines.map((line) => JSON.parse(line));
  tamperedEntries[1].snapshot.matters[0].event_count += 1;
  const tamperedDir = attackJournal(
    "tampered",
    tamperedEntries.map((entry) => JSON.stringify(entry)),
  );
  expectThrows(
    () =>
      verifyAuditAnchorJournal({
        dataDir,
        anchorDir: tamperedDir,
        publicKeyPath,
      }),
    AuditAnchorVerificationError,
  );

  const deletedDir = attackJournal("deleted-middle", [
    originalLines[0],
    originalLines[2],
  ]);
  expectThrows(
    () =>
      verifyAuditAnchorJournal({
        dataDir,
        anchorDir: deletedDir,
        publicKeyPath,
      }),
    AuditAnchorVerificationError,
  );

  const reorderedDir = attackJournal("reordered", [
    originalLines[1],
    originalLines[0],
    originalLines[2],
  ]);
  expectThrows(
    () =>
      verifyAuditAnchorJournal({
        dataDir,
        anchorDir: reorderedDir,
        publicKeyPath,
      }),
    AuditAnchorVerificationError,
  );

  const truncatedDir = attackJournal("truncated", originalLines, false);
  expectThrows(
    () =>
      verifyAuditAnchorJournal({
        dataDir,
        anchorDir: truncatedDir,
        publicKeyPath,
      }),
    AuditAnchorVerificationError,
  );

  const wrongPrivate = path.join(keyDir, "wrong-private.pem");
  const wrongPublic = path.join(keyDir, "wrong-public.pem");
  generateAuditAnchorKeyPair({
    dataDir,
    privateKeyPath: wrongPrivate,
    publicKeyPath: wrongPublic,
  });
  expectThrows(
    () =>
      verifyAuditAnchorJournal({
        dataDir,
        anchorDir,
        publicKeyPath: wrongPublic,
      }),
    AuditAnchorVerificationError,
  );

  expectThrows(
    () =>
      createAuditAnchor(
        { ...config, anchorDir: path.join(dataDir, "forbidden-anchors") },
        "forbidden",
      ),
    AuditAnchorConfigurationError,
  );

  const symlinkDir = path.join(root, "anchor-link");
  symlinkSync(anchorDir, symlinkDir);
  expectThrows(
    () =>
      verifyAuditAnchorJournal({
        dataDir,
        anchorDir: symlinkDir,
        publicKeyPath,
      }),
    AuditAnchorConfigurationError,
  );

  const bundlePath = path.join(root, "verification-bundle.json");
  const bundle = exportAuditAnchorVerificationBundle({
    config,
    outputPath: bundlePath,
  });
  const bundleVerification = verifyAuditAnchorVerificationBundle(bundlePath);
  assert.equal(bundleVerification.journal_head, third.anchor_hash);
  assert.equal(bundleVerification.bundle_hash, bundle.bundle_hash);

  const originalEnvironment = { ...process.env };
  try {
    process.env.ALETHEIA_DATA_DIR = dataDir;
    process.env.ALETHEIA_AUDIT_ANCHOR_ENABLED = "false";
    process.env.ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE = "true";
    expectThrows(
      startAuditAnchorRuntimeFromEnvironment,
      AuditAnchorConfigurationError,
    );

    process.env.ALETHEIA_AUDIT_ANCHOR_ENABLED = "true";
    process.env.ALETHEIA_AUDIT_ANCHOR_DIR = anchorDir;
    process.env.ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE = privateKeyPath;
    process.env.ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE = publicKeyPath;
    const runtime = startAuditAnchorRuntimeFromEnvironment();
    assert.ok(runtime);
    assert.equal(auditAnchorRuntimeStatus().healthy, true);
    const runtimeJournalPath = path.join(anchorDir, "audit-anchors.jsonl");
    const healthyJournal = readFileSync(runtimeJournalPath, "utf8");
    const broken = healthyJournal.trimEnd().split("\n");
    const brokenLast = JSON.parse(broken.at(-1) as string);
    brokenLast.anchor_hash = "sha256:runtime-tamper";
    broken[broken.length - 1] = JSON.stringify(brokenLast);
    writeFileSync(runtimeJournalPath, `${broken.join("\n")}\n`, {
      mode: 0o600,
    });
    expectThrows(runAuditAnchorRuntimeNow, AuditAnchorVerificationError);
    assert.equal(auditAnchorRuntimeStatus().healthy, false);
    assert.equal(shouldFailClosedForAuditAnchor(), true);
    writeFileSync(runtimeJournalPath, healthyJournal, { mode: 0o600 });
    runAuditAnchorRuntimeNow("test_recovery");
    assert.equal(shouldFailClosedForAuditAnchor(), false);
    const beforeTailDeletion = readFileSync(runtimeJournalPath, "utf8");
    const withoutTail = beforeTailDeletion.trimEnd().split("\n");
    withoutTail.pop();
    writeFileSync(runtimeJournalPath, `${withoutTail.join("\n")}\n`, {
      mode: 0o600,
    });
    expectThrows(runAuditAnchorRuntimeNow, AuditAnchorVerificationError);
    assert.equal(shouldFailClosedForAuditAnchor(), true);
    writeFileSync(runtimeJournalPath, beforeTailDeletion, { mode: 0o600 });
    runAuditAnchorRuntimeNow("test_tail_recovery");
    runtime?.close();
  } finally {
    process.env = originalEnvironment;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        schema_version: "aletheia-audit-anchor-journal-audit-v1",
        key_id: generated.key_id,
        journal_entries: verified.entries,
        checks: [
          "signed canonical matter and tombstone heads",
          "restart chain continuation",
          "database audit-head rollback rejection",
          "current database snapshot comparison",
          "tamper rejection",
          "middle deletion rejection",
          "reordering rejection",
          "truncation rejection",
          "wrong public key rejection",
          "inside-data-dir path rejection",
          "symlink rejection",
          "signed portable verification bundle",
          "high-assurance startup and runtime fail-closed recovery",
          "same-process tail deletion detection",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
