import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertBundledDatabaseEncryptionPolicy,
  isAletheiaEnvelope,
  LocalEnvelopeAuthenticationError,
  LegacyPlaintextRejectedError,
  readProtectedLocalFileSync,
  writeProtectedLocalFileSync,
} from "../lib/aletheia/localEnvelopeCrypto";
import { migrateLegacyLocalFiles } from "../lib/aletheia/localEncryptionMigration";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectThrows(
  fn: () => unknown,
  ErrorType: new (...args: any[]) => Error,
) {
  try {
    fn();
  } catch (error) {
    assert(
      error instanceof ErrorType,
      `Expected ${ErrorType.name}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${ErrorType.name}`);
}

const originalEnv = { ...process.env };
const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-encryption-audit-"));
try {
  const documents = path.join(root, "documents");
  const exportsDir = path.join(root, "exports", "matter-one");
  mkdirSync(documents, { recursive: true, mode: 0o700 });
  mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = randomBytes(32).toString("base64");
  delete process.env.ALETHEIA_ALLOW_LEGACY_PLAINTEXT_READ;

  const original = Buffer.from(
    "attorney-client confidential test payload",
    "utf8",
  );
  const protectedPath = path.join(
    documents,
    "11111111-1111-4111-8111-111111111111.txt",
  );
  writeProtectedLocalFileSync({
    filePath: protectedPath,
    plaintext: original,
    purpose: "source_document",
  });
  const atRest = readFileSync(protectedPath);
  assert(
    isAletheiaEnvelope(atRest),
    "protected file must use the Aletheia envelope",
  );
  assert(
    !atRest.includes(original),
    "plaintext must not be visible in the encrypted file",
  );
  assert(
    readProtectedLocalFileSync({
      filePath: protectedPath,
      purpose: "source_document",
    }).equals(original),
    "encrypted document must round-trip",
  );

  const tampered = Buffer.from(atRest);
  tampered[tampered.length - 17] ^= 0x01;
  writeFileSync(protectedPath, tampered);
  expectThrows(
    () =>
      readProtectedLocalFileSync({
        filePath: protectedPath,
        purpose: "source_document",
      }),
    LocalEnvelopeAuthenticationError,
  );
  writeFileSync(protectedPath, atRest);

  const relocated = path.join(
    documents,
    "22222222-2222-4222-8222-222222222222.txt",
  );
  cpSync(protectedPath, relocated);
  expectThrows(
    () =>
      readProtectedLocalFileSync({
        filePath: relocated,
        purpose: "source_document",
      }),
    LocalEnvelopeAuthenticationError,
  );
  rmSync(relocated, { force: true });

  const correctKey = process.env.ALETHEIA_MASTER_KEY_BASE64;
  process.env.ALETHEIA_MASTER_KEY_BASE64 = randomBytes(32).toString("base64");
  expectThrows(
    () =>
      readProtectedLocalFileSync({
        filePath: protectedPath,
        purpose: "source_document",
      }),
    LocalEnvelopeAuthenticationError,
  );
  process.env.ALETHEIA_MASTER_KEY_BASE64 = correctKey;

  const legacyPath = path.join(exportsDir, "legacy.json");
  writeFileSync(legacyPath, original, { mode: 0o600 });
  expectThrows(
    () =>
      readProtectedLocalFileSync({
        filePath: legacyPath,
        purpose: "local_export",
      }),
    LegacyPlaintextRejectedError,
  );
  const dryRun = migrateLegacyLocalFiles({ dataDir: root, apply: false });
  assert(
    dryRun.counts.would_encrypt === 1,
    "dry run must report one legacy file",
  );
  const applied = migrateLegacyLocalFiles({ dataDir: root, apply: true });
  assert(
    applied.counts.encrypted === 1,
    "migration must encrypt the legacy file",
  );
  assert(
    isAletheiaEnvelope(readFileSync(legacyPath)),
    "migrated file must be encrypted",
  );
  const rerun = migrateLegacyLocalFiles({ dataDir: root, apply: true });
  assert(rerun.counts.encrypted === 0, "migration rerun must be idempotent");

  process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
  expectThrows(assertBundledDatabaseEncryptionPolicy, Error);

  console.log(
    JSON.stringify(
      {
        ok: true,
        schema_version: "aletheia-local-encryption-audit-v1",
        checks: [
          "AES-256-GCM round-trip",
          "plaintext absence",
          "ciphertext tamper rejection",
          "AAD path relocation rejection",
          "wrong-key rejection",
          "legacy plaintext fail-closed",
          "idempotent plaintext migration",
          "SQLCipher-required fail-closed",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnv;
  rmSync(root, { recursive: true, force: true });
}
