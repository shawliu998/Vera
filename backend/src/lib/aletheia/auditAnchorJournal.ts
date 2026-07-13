import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { LocalDatabase } from "./localDatabase";

const JOURNAL_FILENAME = "audit-anchors.jsonl";
const ENTRY_SCHEMA = "aletheia-audit-anchor-entry-v1";
const SNAPSHOT_SCHEMA = "aletheia-audit-head-snapshot-v1";
const BUNDLE_SCHEMA = "aletheia-audit-anchor-verification-bundle-v1";
const PUBLIC_KEY_ALGORITHM = "ed25519";

export type AuditHeadSnapshot = {
  schema_version: typeof SNAPSHOT_SCHEMA;
  database_present: boolean;
  matters: Array<{
    matter_id: string;
    event_count: number;
    chained_event_count: number;
    invalid_event_count: number;
    sequence_anomaly_count: number;
    last_sequence: number | null;
    last_event_hash: string | null;
  }>;
  deletion_tombstones: {
    count: number;
    chain_head: string | null;
    latest_tombstone_id: string | null;
    latest_tombstone_hash: string | null;
    latest_deleted_at: string | null;
  };
};

export type AuditAnchorEntry = {
  schema_version: typeof ENTRY_SCHEMA;
  anchor_index: number;
  anchor_id: string;
  created_at: string;
  reason: string;
  key_id: string;
  previous_anchor_hash: string | null;
  snapshot: AuditHeadSnapshot;
  anchor_hash: string;
  signature: {
    algorithm: typeof PUBLIC_KEY_ALGORITHM;
    value: string;
  };
};

export type AuditAnchorConfig = {
  dataDir: string;
  anchorDir: string;
  privateKeyPath: string;
  publicKeyPath: string;
  expectedHeadHash?: string | null;
};

type RuntimeState = {
  enabled: boolean;
  high_assurance: boolean;
  healthy: boolean;
  protection_active: boolean;
  interval_ms: number | null;
  key_id: string | null;
  journal_entries: number;
  journal_head: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_reason: string | null;
  last_error: string | null;
};

export class AuditAnchorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditAnchorConfigurationError";
  }
}

export class AuditAnchorVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditAnchorVerificationError";
  }
}

let runtimeState: RuntimeState = {
  enabled: false,
  high_assurance: false,
  healthy: true,
  protection_active: false,
  interval_ms: null,
  key_id: null,
  journal_entries: 0,
  journal_head: null,
  last_attempt_at: null,
  last_success_at: null,
  last_reason: null,
  last_error: null,
};
let runtimeTimer: NodeJS.Timeout | null = null;
let runtimeConfig: AuditAnchorConfig | null = null;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new AuditAnchorVerificationError(
        "Anchor canonicalization does not allow undefined values.",
      );
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value: Buffer | string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolvedExistingOrLexical(target: string) {
  const resolved = path.resolve(target);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function assertExternalToDataDir(
  target: string,
  dataDir: string,
  description: string,
) {
  const resolvedData = resolvedExistingOrLexical(dataDir);
  const resolvedTarget = resolvedExistingOrLexical(target);
  if (isPathInside(resolvedData, resolvedTarget)) {
    throw new AuditAnchorConfigurationError(
      `${description} must be outside ALETHEIA_DATA_DIR so a vault rewrite cannot silently replace both data and anchors.`,
    );
  }
}

function assertNotSymlink(target: string, description: string) {
  if (lstatSync(target).isSymbolicLink()) {
    throw new AuditAnchorConfigurationError(
      `${description} must not be a symbolic link.`,
    );
  }
}

function ensureOwnerOnlyDirectory(
  target: string,
  dataDir: string,
  create = true,
) {
  assertExternalToDataDir(target, dataDir, "Audit anchor directory");
  if (!existsSync(target)) {
    if (!create) {
      throw new AuditAnchorConfigurationError(
        "Audit anchor directory does not exist.",
      );
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  assertNotSymlink(target, "Audit anchor directory");
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    throw new AuditAnchorConfigurationError(
      "Audit anchor directory is not a directory.",
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new AuditAnchorConfigurationError(
      "Audit anchor directory must be owner-only (0700).",
    );
  }
  return realpathSync(target);
}

function assertRegularFile(
  target: string,
  description: string,
  ownerOnly: boolean,
) {
  assertNotSymlink(target, description);
  const stats = statSync(target);
  if (!stats.isFile()) {
    throw new AuditAnchorConfigurationError(
      `${description} is not a regular file.`,
    );
  }
  if (ownerOnly && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new AuditAnchorConfigurationError(
      `${description} must be owner-only (0600).`,
    );
  }
  return stats;
}

function fsyncDirectory(target: string) {
  if (process.platform === "win32") return;
  const fd = openSync(target, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeExclusiveAndSync(
  target: string,
  bytes: Buffer | string,
  mode: number,
) {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  const fd = openSync(target, flags, mode);
  try {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, mode);
  fsyncDirectory(path.dirname(target));
}

function publicKeyDer(publicKey: KeyObject) {
  return publicKey.export({ type: "spki", format: "der" }) as Buffer;
}

function keyId(publicKey: KeyObject) {
  return createHash("sha256")
    .update(publicKeyDer(publicKey))
    .digest("hex")
    .slice(0, 24);
}

function loadPublicKey(publicKeyPath: string) {
  assertRegularFile(publicKeyPath, "Audit anchor public key", false);
  const key = createPublicKey(readFileSync(publicKeyPath));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new AuditAnchorConfigurationError(
      "Audit anchor public key must be Ed25519.",
    );
  }
  return key;
}

function loadPrivateKey(privateKeyPath: string, dataDir: string) {
  assertExternalToDataDir(privateKeyPath, dataDir, "Audit anchor private key");
  assertRegularFile(privateKeyPath, "Audit anchor private key", true);
  const key = createPrivateKey(readFileSync(privateKeyPath));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new AuditAnchorConfigurationError(
      "Audit anchor private key must be Ed25519.",
    );
  }
  return key;
}

function assertKeyPair(privateKey: KeyObject, publicKey: KeyObject) {
  const derived = createPublicKey(privateKey);
  if (!publicKeyDer(derived).equals(publicKeyDer(publicKey))) {
    throw new AuditAnchorConfigurationError(
      "Audit anchor private and public keys do not form a pair.",
    );
  }
}

function prepareKeyDestination(
  target: string,
  dataDir: string,
  description: string,
) {
  assertExternalToDataDir(target, dataDir, description);
  const parent = path.dirname(path.resolve(target));
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNotSymlink(parent, `${description} parent directory`);
  if (existsSync(target)) {
    throw new AuditAnchorConfigurationError(
      `${description} already exists; refusing to overwrite operator key material.`,
    );
  }
}

export function generateAuditAnchorKeyPair(args: {
  dataDir: string;
  privateKeyPath: string;
  publicKeyPath: string;
}) {
  prepareKeyDestination(
    args.privateKeyPath,
    args.dataDir,
    "Private-key output",
  );
  prepareKeyDestination(args.publicKeyPath, args.dataDir, "Public-key output");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  try {
    writeExclusiveAndSync(args.privateKeyPath, privatePem, 0o600);
    writeExclusiveAndSync(args.publicKeyPath, publicPem, 0o644);
  } catch (error) {
    if (existsSync(args.privateKeyPath) && !existsSync(args.publicKeyPath)) {
      unlinkSync(args.privateKeyPath);
    }
    throw error;
  }
  return {
    algorithm: PUBLIC_KEY_ALGORITHM,
    key_id: keyId(publicKey),
    private_key_path: path.resolve(args.privateKeyPath),
    public_key_path: path.resolve(args.publicKeyPath),
  };
}

export function importAuditAnchorKeyPair(args: {
  dataDir: string;
  sourcePrivateKeyPath: string;
  sourcePublicKeyPath: string;
  destinationPrivateKeyPath: string;
  destinationPublicKeyPath: string;
}) {
  const privateKey = loadPrivateKey(args.sourcePrivateKeyPath, args.dataDir);
  const publicKey = loadPublicKey(args.sourcePublicKeyPath);
  assertKeyPair(privateKey, publicKey);
  prepareKeyDestination(
    args.destinationPrivateKeyPath,
    args.dataDir,
    "Imported private-key output",
  );
  prepareKeyDestination(
    args.destinationPublicKeyPath,
    args.dataDir,
    "Imported public-key output",
  );
  try {
    writeExclusiveAndSync(
      args.destinationPrivateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      0o600,
    );
    writeExclusiveAndSync(
      args.destinationPublicKeyPath,
      publicKey.export({ type: "spki", format: "pem" }),
      0o644,
    );
  } catch (error) {
    if (
      existsSync(args.destinationPrivateKeyPath) &&
      !existsSync(args.destinationPublicKeyPath)
    ) {
      unlinkSync(args.destinationPrivateKeyPath);
    }
    throw error;
  }
  return {
    algorithm: PUBLIC_KEY_ALGORITHM,
    key_id: keyId(publicKey),
    private_key_path: path.resolve(args.destinationPrivateKeyPath),
    public_key_path: path.resolve(args.destinationPublicKeyPath),
  };
}

function tableExists(db: LocalDatabase, table: string) {
  return Boolean(
    db
      .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
      .get(table),
  );
}

export function captureAuditHeadSnapshot(dataDir: string): AuditHeadSnapshot {
  const dbPath = path.join(path.resolve(dataDir), "aletheia.db");
  if (!existsSync(dbPath)) {
    return {
      schema_version: SNAPSHOT_SCHEMA,
      database_present: false,
      matters: [],
      deletion_tombstones: {
        count: 0,
        chain_head: null,
        latest_tombstone_id: null,
        latest_tombstone_hash: null,
        latest_deleted_at: null,
      },
    };
  }

  const db = new LocalDatabase(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const matterIds = new Set<string>();
    if (tableExists(db, "aletheia_matters")) {
      const rows = db
        .prepare("select id from aletheia_matters order by id")
        .all() as Array<{
        id?: unknown;
      }>;
      for (const row of rows) {
        if (typeof row.id === "string") matterIds.add(row.id);
      }
    }

    const grouped = new Map<
      string,
      Array<{ sequence: number | null; eventHash: string | null }>
    >();
    if (tableExists(db, "aletheia_audit_events")) {
      const rows = db
        .prepare(
          `select matter_id, sequence, event_hash
             from aletheia_audit_events
            order by matter_id asc, sequence asc, created_at asc, id asc`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const matterId = String(row.matter_id ?? "");
        if (!matterId) continue;
        matterIds.add(matterId);
        const events = grouped.get(matterId) ?? [];
        events.push({
          sequence:
            typeof row.sequence === "number" && Number.isInteger(row.sequence)
              ? row.sequence
              : null,
          eventHash:
            typeof row.event_hash === "string" && row.event_hash
              ? row.event_hash
              : null,
        });
        grouped.set(matterId, events);
      }
    }
    const matters = [...matterIds]
      .sort((left, right) => left.localeCompare(right))
      .map((matterId) => {
        const events = grouped.get(matterId) ?? [];
        const chained = events
          .filter(
            (event): event is { sequence: number; eventHash: string } =>
              event.sequence !== null && event.eventHash !== null,
          )
          .sort((left, right) => left.sequence - right.sequence);
        const last = chained.at(-1) ?? null;
        const sequenceAnomalyCount = chained.reduce(
          (count, event, index) =>
            count + (event.sequence === index + 1 ? 0 : 1),
          0,
        );
        return {
          matter_id: matterId,
          event_count: events.length,
          chained_event_count: chained.length,
          invalid_event_count:
            events.length - chained.length + sequenceAnomalyCount,
          sequence_anomaly_count: sequenceAnomalyCount,
          last_sequence: last?.sequence ?? null,
          last_event_hash: last?.eventHash ?? null,
        };
      });

    let previousTombstoneHash: string | null = null;
    let latest: {
      id: string;
      tombstoneHash: string;
      deletedAt: string;
    } | null = null;
    let tombstoneCount = 0;
    if (tableExists(db, "aletheia_deletion_tombstones")) {
      const rows = db
        .prepare(
          `select id, matter_id, tombstone_hash, deleted_at
             from aletheia_deletion_tombstones
            order by deleted_at asc, id asc`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const record = {
          id: String(row.id ?? ""),
          matter_id: String(row.matter_id ?? ""),
          tombstone_hash: String(row.tombstone_hash ?? ""),
          deleted_at: String(row.deleted_at ?? ""),
          previous_tombstone_anchor_hash: previousTombstoneHash,
        };
        previousTombstoneHash = sha256(canonicalJson(record));
        latest = {
          id: record.id,
          tombstoneHash: record.tombstone_hash,
          deletedAt: record.deleted_at,
        };
        tombstoneCount += 1;
      }
    }
    return {
      schema_version: SNAPSHOT_SCHEMA,
      database_present: true,
      matters,
      deletion_tombstones: {
        count: tombstoneCount,
        chain_head: previousTombstoneHash,
        latest_tombstone_id: latest?.id ?? null,
        latest_tombstone_hash: latest?.tombstoneHash ?? null,
        latest_deleted_at: latest?.deletedAt ?? null,
      },
    };
  } finally {
    db.close();
  }
}

function entryBody(entry: AuditAnchorEntry) {
  return {
    schema_version: entry.schema_version,
    anchor_index: entry.anchor_index,
    anchor_id: entry.anchor_id,
    created_at: entry.created_at,
    reason: entry.reason,
    key_id: entry.key_id,
    previous_anchor_hash: entry.previous_anchor_hash,
    snapshot: entry.snapshot,
  };
}

function readJournal(anchorDir: string, dataDir: string, create = false) {
  const canonicalDir = ensureOwnerOnlyDirectory(anchorDir, dataDir, create);
  const journalPath = path.join(canonicalDir, JOURNAL_FILENAME);
  if (!existsSync(journalPath)) {
    return { entries: [] as AuditAnchorEntry[], journalPath, bytes: 0 };
  }
  const stats = assertRegularFile(journalPath, "Audit anchor journal", true);
  const value = readFileSync(journalPath, "utf8");
  if (value.length > 0 && !value.endsWith("\n")) {
    throw new AuditAnchorVerificationError(
      "Audit anchor journal is truncated or missing its final record delimiter.",
    );
  }
  const entries = value
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as AuditAnchorEntry;
      } catch {
        throw new AuditAnchorVerificationError(
          `Audit anchor journal line ${index + 1} is not valid JSON.`,
        );
      }
    });
  return { entries, journalPath, bytes: stats.size };
}

function verifyEntries(entries: AuditAnchorEntry[], publicKey: KeyObject) {
  const expectedKeyId = keyId(publicKey);
  let previousAnchorHash: string | null = null;
  const anchorIds = new Set<string>();
  let previousSnapshot: AuditHeadSnapshot | null = null;
  for (const [index, entry] of entries.entries()) {
    const line = index + 1;
    if (
      entry.schema_version !== ENTRY_SCHEMA ||
      entry.anchor_index !== line ||
      typeof entry.anchor_id !== "string" ||
      typeof entry.created_at !== "string" ||
      typeof entry.reason !== "string" ||
      entry.key_id !== expectedKeyId ||
      entry.signature?.algorithm !== PUBLIC_KEY_ALGORITHM ||
      typeof entry.signature.value !== "string"
    ) {
      throw new AuditAnchorVerificationError(
        `Audit anchor journal entry ${line} has an invalid schema, index, or key identity.`,
      );
    }
    if (anchorIds.has(entry.anchor_id)) {
      throw new AuditAnchorVerificationError(
        `Audit anchor journal entry ${line} reuses an anchor id.`,
      );
    }
    anchorIds.add(entry.anchor_id);
    if (entry.previous_anchor_hash !== previousAnchorHash) {
      throw new AuditAnchorVerificationError(
        `Audit anchor journal chain is broken at entry ${line}.`,
      );
    }
    const bodyBytes = Buffer.from(canonicalJson(entryBody(entry)), "utf8");
    const expectedHash = sha256(bodyBytes);
    if (entry.anchor_hash !== expectedHash) {
      throw new AuditAnchorVerificationError(
        `Audit anchor journal entry ${line} hash does not match its canonical body.`,
      );
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(entry.signature.value, "base64");
    } catch {
      throw new AuditAnchorVerificationError(
        `Audit anchor journal entry ${line} signature is not base64.`,
      );
    }
    if (!verify(null, bodyBytes, publicKey, signature)) {
      throw new AuditAnchorVerificationError(
        `Audit anchor journal entry ${line} signature verification failed.`,
      );
    }
    if (previousSnapshot) {
      validateSnapshotTransition(previousSnapshot, entry.snapshot, line);
    }
    previousSnapshot = entry.snapshot;
    previousAnchorHash = entry.anchor_hash;
  }
  return {
    entries: entries.length,
    key_id: expectedKeyId,
    head: previousAnchorHash,
    last_snapshot: entries.at(-1)?.snapshot ?? null,
  };
}

function validateSnapshotTransition(
  previous: AuditHeadSnapshot,
  current: AuditHeadSnapshot,
  entryNumber: number,
) {
  if (previous.database_present && !current.database_present) {
    throw new AuditAnchorVerificationError(
      `Audit anchor entry ${entryNumber} regresses from a present database to a missing database.`,
    );
  }
  const previousTombstones = previous.deletion_tombstones;
  const currentTombstones = current.deletion_tombstones;
  if (currentTombstones.count < previousTombstones.count) {
    throw new AuditAnchorVerificationError(
      `Audit anchor entry ${entryNumber} decreases the deletion-tombstone count.`,
    );
  }
  if (
    currentTombstones.count === previousTombstones.count &&
    currentTombstones.chain_head !== previousTombstones.chain_head
  ) {
    throw new AuditAnchorVerificationError(
      `Audit anchor entry ${entryNumber} changes the tombstone head without adding a tombstone.`,
    );
  }
  if (
    currentTombstones.count > previousTombstones.count &&
    (!currentTombstones.chain_head ||
      currentTombstones.chain_head === previousTombstones.chain_head)
  ) {
    throw new AuditAnchorVerificationError(
      `Audit anchor entry ${entryNumber} adds tombstones without advancing their chain head.`,
    );
  }
  const currentMatters = new Map(
    current.matters.map((matter) => [matter.matter_id, matter]),
  );
  for (const prior of previous.matters) {
    const next = currentMatters.get(prior.matter_id);
    if (!next) {
      if (currentTombstones.count <= previousTombstones.count) {
        throw new AuditAnchorVerificationError(
          `Audit anchor entry ${entryNumber} removes matter ${prior.matter_id} without advancing the deletion-tombstone chain.`,
        );
      }
      continue;
    }
    if (
      next.event_count < prior.event_count ||
      next.chained_event_count < prior.chained_event_count ||
      (prior.last_sequence !== null &&
        (next.last_sequence === null ||
          next.last_sequence < prior.last_sequence))
    ) {
      throw new AuditAnchorVerificationError(
        `Audit anchor entry ${entryNumber} regresses the audit head for matter ${prior.matter_id}.`,
      );
    }
    if (
      next.last_sequence === prior.last_sequence &&
      next.last_event_hash !== prior.last_event_hash
    ) {
      throw new AuditAnchorVerificationError(
        `Audit anchor entry ${entryNumber} changes the event hash without advancing sequence for matter ${prior.matter_id}.`,
      );
    }
  }
}

export function verifyAuditAnchorJournal(args: {
  dataDir: string;
  anchorDir: string;
  publicKeyPath: string;
  compareCurrentSnapshot?: boolean;
  expectedHeadHash?: string | null;
}) {
  const publicKey = loadPublicKey(args.publicKeyPath);
  const journal = readJournal(args.anchorDir, args.dataDir);
  const verified = verifyEntries(journal.entries, publicKey);
  if (args.expectedHeadHash && verified.head !== args.expectedHeadHash) {
    throw new AuditAnchorVerificationError(
      "Audit anchor journal head does not match the independently retained expected head.",
    );
  }
  let currentSnapshotMatches: boolean | null = null;
  if (args.compareCurrentSnapshot) {
    if (!verified.last_snapshot) {
      throw new AuditAnchorVerificationError(
        "Audit anchor journal is empty and cannot verify the current database state.",
      );
    }
    const current = captureAuditHeadSnapshot(args.dataDir);
    currentSnapshotMatches =
      canonicalJson(current) === canonicalJson(verified.last_snapshot);
    if (!currentSnapshotMatches) {
      throw new AuditAnchorVerificationError(
        "Current SQLite audit heads do not match the latest signed anchor snapshot.",
      );
    }
  }
  return {
    ok: true,
    schema_version: "aletheia-audit-anchor-verification-v1",
    journal_path: journal.journalPath,
    journal_bytes: journal.bytes,
    entries: verified.entries,
    key_id: verified.key_id,
    journal_head: verified.head,
    current_snapshot_matches: currentSnapshotMatches,
  };
}

export function findExactMatterAuditAnchorCoverage(args: {
  dataDir: string;
  anchorDir: string;
  publicKeyPath: string;
  matterId: string;
  eventSequence: number;
  eventHash: string;
  expectedHeadHash?: string | null;
}) {
  const publicKey = loadPublicKey(args.publicKeyPath);
  const journal = readJournal(args.anchorDir, args.dataDir);
  const verified = verifyEntries(journal.entries, publicKey);
  if (
    args.expectedHeadHash !== undefined &&
    verified.head !== args.expectedHeadHash
  ) {
    throw new AuditAnchorVerificationError(
      "Audit anchor journal head does not match the independently retained expected head.",
    );
  }
  const entry = journal.entries.find((candidate) => {
    const matter = candidate.snapshot.matters.find(
      (item) => item.matter_id === args.matterId,
    );
    return (
      matter?.invalid_event_count === 0 &&
      matter.sequence_anomaly_count === 0 &&
      matter.last_sequence === args.eventSequence &&
      matter.last_event_hash === args.eventHash
    );
  });
  if (!entry) return null;
  const matter = entry.snapshot.matters.find(
    (item) => item.matter_id === args.matterId,
  )!;
  return {
    schema_version: "aletheia-litigation-signoff-anchor-coverage-v1",
    coverage: "exact_matter_audit_head" as const,
    anchor_id: entry.anchor_id,
    anchor_index: entry.anchor_index,
    anchor_hash: entry.anchor_hash,
    anchored_at: entry.created_at,
    reason: entry.reason,
    key_id: entry.key_id,
    signature_algorithm: entry.signature.algorithm,
    signature: entry.signature.value,
    journal_head: verified.head,
    journal_entries: verified.entries,
    matter_head: matter,
  };
}

export function validateAuditAnchorConfiguration(config: AuditAnchorConfig) {
  const anchorDir = ensureOwnerOnlyDirectory(
    config.anchorDir,
    config.dataDir,
    false,
  );
  const privateKey = loadPrivateKey(config.privateKeyPath, config.dataDir);
  const publicKey = loadPublicKey(config.publicKeyPath);
  assertKeyPair(privateKey, publicKey);
  const journal = readJournal(anchorDir, config.dataDir);
  const verified = verifyEntries(journal.entries, publicKey);
  return {
    ok: true,
    key_id: verified.key_id,
    journal_entries: verified.entries,
    journal_head: verified.head,
  };
}

function acquireJournalLock(anchorDir: string) {
  const lockIdentity = createHash("sha256")
    .update(realpathSync(anchorDir))
    .digest("hex")
    .slice(0, 24);
  const lockPath = path.join(
    os.tmpdir(),
    `aletheia-audit-anchor-${lockIdentity}.lock`,
  );
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch {
    throw new AuditAnchorConfigurationError(
      `Audit anchor writer lock already exists at ${lockPath}; another writer may be active or an operator must review a stale lock.`,
    );
  }
  return () => {
    try {
      rmdirSync(lockPath);
    } catch {
      // A retained lock is safer than silently ignoring a concurrent-writer signal.
    }
  };
}

export function createAuditAnchor(
  config: AuditAnchorConfig,
  reason = "manual",
  expectedHeadHash: string | null | undefined = config.expectedHeadHash,
) {
  const anchorDir = ensureOwnerOnlyDirectory(config.anchorDir, config.dataDir);
  const releaseLock = acquireJournalLock(anchorDir);
  try {
    const privateKey = loadPrivateKey(config.privateKeyPath, config.dataDir);
    const publicKey = loadPublicKey(config.publicKeyPath);
    assertKeyPair(privateKey, publicKey);
    const journal = readJournal(anchorDir, config.dataDir, true);
    const verified = verifyEntries(journal.entries, publicKey);
    if (expectedHeadHash !== undefined && verified.head !== expectedHeadHash) {
      throw new AuditAnchorVerificationError(
        "Audit anchor journal head does not match the independently retained expected head; refusing to append a fork.",
      );
    }
    const snapshot = captureAuditHeadSnapshot(config.dataDir);
    if (verified.last_snapshot) {
      validateSnapshotTransition(
        verified.last_snapshot,
        snapshot,
        verified.entries + 1,
      );
    }
    const body = {
      schema_version: ENTRY_SCHEMA,
      anchor_index: verified.entries + 1,
      anchor_id: randomUUID(),
      created_at: new Date().toISOString(),
      reason,
      key_id: verified.key_id,
      previous_anchor_hash: verified.head,
      snapshot,
    } satisfies ReturnType<typeof entryBody>;
    const bodyBytes = Buffer.from(canonicalJson(body), "utf8");
    const entry: AuditAnchorEntry = {
      ...body,
      anchor_hash: sha256(bodyBytes),
      signature: {
        algorithm: PUBLIC_KEY_ALGORITHM,
        value: sign(null, bodyBytes, privateKey).toString("base64"),
      },
    };
    const flags =
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(journal.journalPath, flags, 0o600);
    try {
      const fileStats = fstatSync(fd);
      if (!fileStats.isFile() || fileStats.size !== journal.bytes) {
        throw new AuditAnchorVerificationError(
          "Audit anchor journal changed after verification; refusing a forked append.",
        );
      }
      if (process.platform !== "win32" && (fileStats.mode & 0o077) !== 0) {
        throw new AuditAnchorConfigurationError(
          "Audit anchor journal must be owner-only (0600).",
        );
      }
      const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
      let offset = 0;
      while (offset < line.length) {
        offset += writeSync(fd, line, offset, line.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(anchorDir);
    return {
      ...entry,
      reason,
      journal_path: journal.journalPath,
    };
  } finally {
    releaseLock();
  }
}

function writeBundle(target: string, value: unknown) {
  if (existsSync(target)) {
    throw new AuditAnchorConfigurationError(
      "Verification bundle output already exists; refusing to overwrite it.",
    );
  }
  const parent = path.dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeExclusiveAndSync(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      0o600,
    );
    linkSync(temporary, target);
    unlinkSync(temporary);
    chmodSync(target, 0o600);
    fsyncDirectory(parent);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function exportAuditAnchorVerificationBundle(args: {
  config: AuditAnchorConfig;
  outputPath: string;
}) {
  assertExternalToDataDir(
    args.outputPath,
    args.config.dataDir,
    "Audit verification bundle",
  );
  const privateKey = loadPrivateKey(
    args.config.privateKeyPath,
    args.config.dataDir,
  );
  const publicKey = loadPublicKey(args.config.publicKeyPath);
  assertKeyPair(privateKey, publicKey);
  const journal = readJournal(args.config.anchorDir, args.config.dataDir);
  const verified = verifyEntries(journal.entries, publicKey);
  const body = {
    schema_version: BUNDLE_SCHEMA,
    exported_at: new Date().toISOString(),
    key_id: verified.key_id,
    journal_head: verified.head,
    entries: journal.entries,
    public_key_pem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
  const bodyBytes = Buffer.from(canonicalJson(body), "utf8");
  const bundle = {
    ...body,
    bundle_hash: sha256(bodyBytes),
    signature: {
      algorithm: PUBLIC_KEY_ALGORITHM,
      value: sign(null, bodyBytes, privateKey).toString("base64"),
    },
  };
  writeBundle(path.resolve(args.outputPath), bundle);
  return {
    schema_version: BUNDLE_SCHEMA,
    output_path: path.resolve(args.outputPath),
    entries: verified.entries,
    key_id: verified.key_id,
    journal_head: verified.head,
    bundle_hash: bundle.bundle_hash,
  };
}

export function verifyAuditAnchorVerificationBundle(bundlePath: string) {
  assertRegularFile(bundlePath, "Audit verification bundle", true);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
    schema_version: string;
    exported_at: string;
    key_id: string;
    journal_head: string | null;
    entries: AuditAnchorEntry[];
    public_key_pem: string;
    bundle_hash: string;
    signature: { algorithm: string; value: string };
  };
  if (
    bundle.schema_version !== BUNDLE_SCHEMA ||
    bundle.signature?.algorithm !== PUBLIC_KEY_ALGORITHM
  ) {
    throw new AuditAnchorVerificationError(
      "Audit verification bundle schema is invalid.",
    );
  }
  const publicKey = createPublicKey(bundle.public_key_pem);
  const verifiedEntries = verifyEntries(bundle.entries, publicKey);
  if (
    bundle.key_id !== verifiedEntries.key_id ||
    bundle.journal_head !== verifiedEntries.head
  ) {
    throw new AuditAnchorVerificationError(
      "Audit verification bundle manifest does not match its journal entries.",
    );
  }
  const body = {
    schema_version: bundle.schema_version,
    exported_at: bundle.exported_at,
    key_id: bundle.key_id,
    journal_head: bundle.journal_head,
    entries: bundle.entries,
    public_key_pem: bundle.public_key_pem,
  };
  const bodyBytes = Buffer.from(canonicalJson(body), "utf8");
  if (
    bundle.bundle_hash !== sha256(bodyBytes) ||
    !verify(
      null,
      bodyBytes,
      publicKey,
      Buffer.from(bundle.signature.value, "base64"),
    )
  ) {
    throw new AuditAnchorVerificationError(
      "Audit verification bundle signature or hash is invalid.",
    );
  }
  return {
    ok: true,
    schema_version: "aletheia-audit-anchor-bundle-verification-v1",
    entries: verifiedEntries.entries,
    key_id: verifiedEntries.key_id,
    journal_head: verifiedEntries.head,
    bundle_hash: bundle.bundle_hash,
  };
}

function configFromEnvironment(): AuditAnchorConfig {
  const dataDir = path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  );
  const anchorDir = process.env.ALETHEIA_AUDIT_ANCHOR_DIR?.trim();
  const privateKeyPath =
    process.env.ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE?.trim();
  const publicKeyPath =
    process.env.ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE?.trim();
  if (!anchorDir || !privateKeyPath || !publicKeyPath) {
    throw new AuditAnchorConfigurationError(
      "Audit anchoring requires ALETHEIA_AUDIT_ANCHOR_DIR, ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE, and ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE.",
    );
  }
  return {
    dataDir,
    anchorDir: path.resolve(anchorDir),
    privateKeyPath: path.resolve(privateKeyPath),
    publicKeyPath: path.resolve(publicKeyPath),
    expectedHeadHash:
      process.env.ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH?.trim() || undefined,
  };
}

export function auditAnchorConfigFromEnvironment() {
  return configFromEnvironment();
}

function configuredIntervalMs() {
  const raw = Number(process.env.ALETHEIA_AUDIT_ANCHOR_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15 * 60 * 1000;
  return Math.max(60_000, Math.floor(raw));
}

function runRuntimeAnchor(reason: string) {
  runtimeState.last_attempt_at = new Date().toISOString();
  runtimeState.last_reason = reason;
  try {
    if (!runtimeConfig)
      throw new Error("Audit anchor runtime is not configured.");
    const expectedHead = runtimeState.last_success_at
      ? runtimeState.journal_head
      : runtimeConfig.expectedHeadHash;
    const entry = createAuditAnchor(runtimeConfig, reason, expectedHead);
    runtimeState = {
      ...runtimeState,
      healthy: true,
      protection_active: true,
      key_id: entry.key_id,
      journal_entries: entry.anchor_index,
      journal_head: entry.anchor_hash,
      last_success_at: new Date().toISOString(),
      last_error: null,
    };
    return entry;
  } catch (error) {
    runtimeState = {
      ...runtimeState,
      healthy: false,
      protection_active: false,
      last_error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

export function startAuditAnchorRuntimeFromEnvironment() {
  const enabled = process.env.ALETHEIA_AUDIT_ANCHOR_ENABLED === "true";
  const highAssurance =
    process.env.ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE === "true";
  if (highAssurance && !enabled) {
    throw new AuditAnchorConfigurationError(
      "High-assurance audit anchoring cannot start while ALETHEIA_AUDIT_ANCHOR_ENABLED is false.",
    );
  }
  if (!enabled) {
    runtimeState = {
      enabled: false,
      high_assurance: highAssurance,
      healthy: true,
      protection_active: false,
      interval_ms: null,
      key_id: null,
      journal_entries: 0,
      journal_head: null,
      last_attempt_at: null,
      last_success_at: null,
      last_reason: null,
      last_error: null,
    };
    return null;
  }
  const intervalMs = configuredIntervalMs();
  runtimeState = {
    enabled: true,
    high_assurance: highAssurance,
    healthy: true,
    protection_active: false,
    interval_ms: intervalMs,
    key_id: null,
    journal_entries: 0,
    journal_head: null,
    last_attempt_at: null,
    last_success_at: null,
    last_reason: null,
    last_error: null,
  };
  try {
    runtimeConfig = configFromEnvironment();
  } catch (error) {
    runtimeState = {
      ...runtimeState,
      healthy: false,
      protection_active: false,
      last_attempt_at: new Date().toISOString(),
      last_reason: "startup_configuration",
      last_error: error instanceof Error ? error.message : String(error),
    };
    if (highAssurance) throw error;
    return null;
  }
  try {
    runRuntimeAnchor("startup");
  } catch (error) {
    if (highAssurance) throw error;
  }
  runtimeTimer = setInterval(() => {
    try {
      runRuntimeAnchor("interval");
    } catch {
      // Health and high-assurance mutation guards expose the failure.
    }
  }, intervalMs);
  runtimeTimer.unref();
  return {
    close() {
      if (runtimeTimer) clearInterval(runtimeTimer);
      runtimeTimer = null;
      runRuntimeAnchor("shutdown");
    },
  };
}

export function auditAnchorRuntimeStatus() {
  return {
    schema_version: "aletheia-audit-anchor-runtime-status-v1",
    ...runtimeState,
    storage_assurance:
      "external_append_target; true WORM/remote immutability is operator-provided and not inferred from an ordinary filesystem",
  };
}

export function runAuditAnchorRuntimeNow(reason = "operator_runtime") {
  if (!runtimeState.enabled || !runtimeConfig) {
    throw new AuditAnchorConfigurationError(
      "Audit anchor runtime is not enabled or configured.",
    );
  }
  return runRuntimeAnchor(reason);
}

export function shouldFailClosedForAuditAnchor() {
  return (
    runtimeState.high_assurance &&
    (!runtimeState.enabled ||
      !runtimeState.healthy ||
      !runtimeState.protection_active)
  );
}
