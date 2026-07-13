import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("ALETHEIAENC\0", "ascii");
const FORMAT_VERSION = 1;
const HEADER_LENGTH_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_HEADER_BYTES = 16 * 1024;
const MACOS_KEYCHAIN_SERVICE = "com.aletheia.desktop.application-encryption";
const MACOS_KEYCHAIN_ACCOUNT = "aletheia-local-master-key";
let macOsKeychainKeyCache: Buffer | null = null;

export type LocalFilePurpose =
  | "source_document"
  | "local_export"
  | "local_secret";
export type ApplicationEncryptionMode = "disabled" | "required";
export type DatabaseEncryptionMode =
  | "metadata_plaintext"
  | "sqlcipher_required";

let verifiedSqlcipherStatus: Record<string, unknown> | null = null;

type EnvelopeHeader = {
  format: "aletheia-envelope";
  version: 1;
  algorithm: "aes-256-gcm";
  key_id: string;
  purpose: LocalFilePurpose;
  context: { relative_path: string };
  nonce: string;
};

export class LocalEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEncryptionConfigurationError";
  }
}

export class LocalEnvelopeAuthenticationError extends Error {
  constructor(message = "Encrypted file authentication failed.") {
    super(message);
    this.name = "LocalEnvelopeAuthenticationError";
  }
}

export class LegacyPlaintextRejectedError extends Error {
  constructor(filePath: string) {
    super(
      `Legacy plaintext file is not allowed while application encryption is required: ${filePath}`,
    );
    this.name = "LegacyPlaintextRejectedError";
  }
}

function configuredDataDir() {
  return path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  );
}

function persistedSemanticIndexMayContainPlaintext() {
  const configured = process.env.ALETHEIA_SEMANTIC_INDEX_DIR?.trim();
  const root = path.resolve(
    configured || path.join(configuredDataDir(), "index", "semantic-local"),
  );
  if (!existsSync(root)) return false;
  const pending = [root];
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || stats.isFile()) return true;
      if (!stats.isDirectory()) continue;
      for (const entry of readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    }
    return false;
  } catch {
    // An unreadable existing index cannot be proven free of plaintext.
    return true;
  }
}

export function applicationEncryptionMode(): ApplicationEncryptionMode {
  const configured =
    process.env.ALETHEIA_APPLICATION_ENCRYPTION?.trim().toLowerCase();
  if (!configured || configured === "disabled") return "disabled";
  if (configured === "required") return "required";
  throw new LocalEncryptionConfigurationError(
    "ALETHEIA_APPLICATION_ENCRYPTION must be either disabled or required.",
  );
}

export function databaseEncryptionMode(): DatabaseEncryptionMode {
  const configured =
    process.env.ALETHEIA_DATABASE_ENCRYPTION?.trim().toLowerCase();
  if (!configured || configured === "metadata_plaintext") {
    return "metadata_plaintext";
  }
  if (configured === "sqlcipher_required") return "sqlcipher_required";
  throw new LocalEncryptionConfigurationError(
    "ALETHEIA_DATABASE_ENCRYPTION must be metadata_plaintext or sqlcipher_required.",
  );
}

export function assertBundledDatabaseEncryptionPolicy() {
  if (databaseEncryptionMode() === "sqlcipher_required") {
    try {
      const { verifySqlcipherRuntime } =
        require("./localDatabase") as typeof import("./localDatabase");
      verifiedSqlcipherStatus = verifySqlcipherRuntime();
    } catch (error) {
      throw new LocalEncryptionConfigurationError(
        `SQLCipher is required but the verified @signalapp/sqlcipher runtime or dedicated key is unavailable. Refusing startup. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function assertLocalEncryptionStartupPolicy() {
  assertBundledDatabaseEncryptionPolicy();
  if (applicationEncryptionMode() === "required") loadApplicationMasterKey();
}

function decodeConfiguredKey(value: string, source: string) {
  const trimmed = value.trim();
  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    key = Buffer.from(trimmed, "base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new LocalEncryptionConfigurationError(
      `${source} must contain exactly 32 random bytes encoded as base64 or 64 hexadecimal characters.`,
    );
  }
  return key;
}

function keyFromFile(filePath: string) {
  const resolved = path.resolve(filePath);
  const stats = statSync(resolved);
  if (!stats.isFile()) {
    throw new LocalEncryptionConfigurationError(
      "ALETHEIA_MASTER_KEY_FILE must point to a regular file.",
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new LocalEncryptionConfigurationError(
      "ALETHEIA_MASTER_KEY_FILE must not be accessible by group or other users (expected mode 0600).",
    );
  }
  const raw = readFileSync(resolved);
  return raw.length === KEY_BYTES
    ? raw
    : decodeConfiguredKey(raw.toString("utf8"), "ALETHEIA_MASTER_KEY_FILE");
}

function keyFromMacOsKeychain() {
  if (process.platform !== "darwin") {
    throw new LocalEncryptionConfigurationError(
      "The macos_keychain master-key source is only available on macOS.",
    );
  }
  if (macOsKeychainKeyCache) return Buffer.from(macOsKeychainKeyCache);
  try {
    const value = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        MACOS_KEYCHAIN_SERVICE,
        "-a",
        MACOS_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const key = decodeConfiguredKey(value, "macOS Keychain item");
    macOsKeychainKeyCache = Buffer.from(key);
    return key;
  } catch (error) {
    throw new LocalEncryptionConfigurationError(
      `Unable to load the application-encryption key from macOS Keychain (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

export function loadApplicationMasterKey() {
  const source = process.env.ALETHEIA_MASTER_KEY_SOURCE?.trim().toLowerCase();
  if (!source || source === "env") {
    const configured = process.env.ALETHEIA_MASTER_KEY_BASE64?.trim();
    if (!configured) {
      throw new LocalEncryptionConfigurationError(
        "Application encryption is required but ALETHEIA_MASTER_KEY_BASE64 is missing. Supply an independent operator key; no default key is embedded.",
      );
    }
    return decodeConfiguredKey(configured, "ALETHEIA_MASTER_KEY_BASE64");
  }
  if (source === "file") {
    const filePath = process.env.ALETHEIA_MASTER_KEY_FILE?.trim();
    if (!filePath) {
      throw new LocalEncryptionConfigurationError(
        "ALETHEIA_MASTER_KEY_SOURCE=file requires ALETHEIA_MASTER_KEY_FILE.",
      );
    }
    return keyFromFile(filePath);
  }
  if (source === "macos_keychain") return keyFromMacOsKeychain();
  throw new LocalEncryptionConfigurationError(
    "ALETHEIA_MASTER_KEY_SOURCE must be env, file, or macos_keychain.",
  );
}

export function storeApplicationMasterKeyInMacOsKeychain(key: Buffer) {
  if (process.platform !== "darwin") {
    throw new LocalEncryptionConfigurationError(
      "Application-key import into macOS Keychain is only available on macOS.",
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new LocalEncryptionConfigurationError(
      "Only an exact 32-byte application master key can be imported.",
    );
  }
  try {
    execFileSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-s",
        MACOS_KEYCHAIN_SERVICE,
        "-a",
        MACOS_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      {
        encoding: "utf8",
        input: `${key.toString("base64")}\n`,
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    macOsKeychainKeyCache = Buffer.from(key);
  } catch (error) {
    throw new LocalEncryptionConfigurationError(
      `Unable to import the application master key into macOS Keychain (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function keyId(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function relativePathContext(filePath: string) {
  const root = configuredDataDir();
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LocalEncryptionConfigurationError(
      "Protected local files must be located below ALETHEIA_DATA_DIR so their authenticated identity is stable.",
    );
  }
  return relative.split(path.sep).join("/");
}

export function isAletheiaEnvelope(value: Buffer) {
  return (
    value.length >= MAGIC.length &&
    value.subarray(0, MAGIC.length).equals(MAGIC)
  );
}

function envelopeHeader(value: Buffer) {
  if (!isAletheiaEnvelope(value)) return null;
  if (value.length < MAGIC.length + HEADER_LENGTH_BYTES) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file header is truncated.",
    );
  }
  const headerLength = value.readUInt32BE(MAGIC.length);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file header length is invalid.",
    );
  }
  const headerStart = MAGIC.length + HEADER_LENGTH_BYTES;
  const headerEnd = headerStart + headerLength;
  if (value.length < headerEnd + TAG_BYTES) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file payload is truncated.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      value.subarray(headerStart, headerEnd).toString("utf8"),
    );
  } catch {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file header is not valid JSON.",
    );
  }
  const header = parsed as Partial<EnvelopeHeader>;
  if (
    header.format !== "aletheia-envelope" ||
    header.version !== FORMAT_VERSION ||
    header.algorithm !== "aes-256-gcm" ||
    typeof header.key_id !== "string" ||
    (header.purpose !== "source_document" &&
      header.purpose !== "local_export" &&
      header.purpose !== "local_secret") ||
    typeof header.context?.relative_path !== "string" ||
    typeof header.nonce !== "string"
  ) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file header schema is invalid.",
    );
  }
  const nonce = Buffer.from(header.nonce, "base64");
  if (nonce.length !== NONCE_BYTES) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file nonce is invalid.",
    );
  }
  return {
    header: header as EnvelopeHeader,
    headerBytes: value.subarray(headerStart, headerEnd),
    payloadStart: headerEnd,
    nonce,
  };
}

export function encryptLocalBuffer(args: {
  plaintext: Buffer;
  filePath: string;
  purpose: LocalFilePurpose;
  key?: Buffer;
}) {
  const key = args.key ?? loadApplicationMasterKey();
  if (key.length !== KEY_BYTES) {
    throw new LocalEncryptionConfigurationError(
      "AES-256-GCM requires a 32-byte key.",
    );
  }
  const nonce = randomBytes(NONCE_BYTES);
  const header: EnvelopeHeader = {
    format: "aletheia-envelope",
    version: FORMAT_VERSION,
    algorithm: "aes-256-gcm",
    key_id: keyId(key),
    purpose: args.purpose,
    context: { relative_path: relativePathContext(args.filePath) },
    nonce: nonce.toString("base64"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([
    cipher.update(args.plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
  headerLength.writeUInt32BE(headerBytes.length);
  return Buffer.concat([MAGIC, headerLength, headerBytes, ciphertext, tag]);
}

export function decryptLocalBuffer(args: {
  envelope: Buffer;
  filePath: string;
  purpose: LocalFilePurpose;
  key?: Buffer;
}) {
  const parsed = envelopeHeader(args.envelope);
  if (!parsed) {
    throw new LegacyPlaintextRejectedError(args.filePath);
  }
  const expectedRelativePath = relativePathContext(args.filePath);
  if (
    parsed.header.purpose !== args.purpose ||
    parsed.header.context.relative_path !== expectedRelativePath
  ) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file purpose or authenticated path does not match the requested file.",
    );
  }
  const key = args.key ?? loadApplicationMasterKey();
  if (parsed.header.key_id !== keyId(key)) {
    throw new LocalEnvelopeAuthenticationError(
      "Encrypted file key identifier does not match the configured master key.",
    );
  }
  const tagStart = args.envelope.length - TAG_BYTES;
  const ciphertext = args.envelope.subarray(parsed.payloadStart, tagStart);
  const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(parsed.headerBytes);
  decipher.setAuthTag(args.envelope.subarray(tagStart));
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new LocalEnvelopeAuthenticationError();
  }
}

export function writeProtectedLocalFileSync(args: {
  filePath: string;
  plaintext: Buffer | string;
  purpose: LocalFilePurpose;
}) {
  const plaintext = Buffer.isBuffer(args.plaintext)
    ? args.plaintext
    : Buffer.from(args.plaintext, "utf8");
  const bytes =
    applicationEncryptionMode() === "required"
      ? encryptLocalBuffer({ ...args, plaintext })
      : plaintext;
  const temporaryPath = `${args.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, bytes, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, args.filePath);
    chmodSync(args.filePath, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The write may have failed before the temporary file was created.
    }
    throw error;
  }
  return {
    encrypted: isAletheiaEnvelope(bytes),
    bytesWritten: bytes.length,
  };
}

export function readProtectedLocalFileSync(args: {
  filePath: string;
  purpose: LocalFilePurpose;
}) {
  const bytes = readFileSync(args.filePath);
  if (isAletheiaEnvelope(bytes))
    return decryptLocalBuffer({ ...args, envelope: bytes });
  if (
    applicationEncryptionMode() === "required" &&
    process.env.ALETHEIA_ALLOW_LEGACY_PLAINTEXT_READ !== "true"
  ) {
    throw new LegacyPlaintextRejectedError(args.filePath);
  }
  return bytes;
}

export function localEncryptionStatus() {
  const mode = applicationEncryptionMode();
  let keySource: "none" | "env" | "file" | "macos_keychain" = "none";
  let keyAvailable = false;
  let keyIdentifier: string | null = null;
  if (mode === "required") {
    const source = process.env.ALETHEIA_MASTER_KEY_SOURCE?.trim().toLowerCase();
    keySource =
      source === "file" || source === "macos_keychain" ? source : "env";
    const key = loadApplicationMasterKey();
    keyAvailable = true;
    keyIdentifier = keyId(key);
  }
  const databaseMode = databaseEncryptionMode();
  if (databaseMode === "sqlcipher_required" && !verifiedSqlcipherStatus) {
    assertBundledDatabaseEncryptionPolicy();
  }
  return {
    schema_version: "aletheia-local-encryption-status-v2",
    file_encryption:
      mode === "required" ? "aes-256-gcm-envelope-v1" : "disabled",
    key_source: keySource,
    key_available: keyAvailable,
    key_identifier: keyIdentifier,
    legacy_plaintext_read:
      mode === "disabled" ||
      process.env.ALETHEIA_ALLOW_LEGACY_PLAINTEXT_READ === "true",
    database_encryption: databaseMode,
    database_driver:
      databaseMode === "sqlcipher_required"
        ? verifiedSqlcipherStatus
        : {
            driver: "node:sqlite",
            encrypted: false,
            limitation: "not SQLCipher",
          },
    plaintext_database_exposure:
      databaseMode === "sqlcipher_required"
        ? []
        : [
            "matter and document metadata",
            "parsed text and FTS index",
            "work-product content",
            "audit and workflow records",
          ],
    plaintext_external_index_exposure:
      process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED === "true" ||
      persistedSemanticIndexMayContainPlaintext()
        ? [
            "semantic index contents are stored outside SQLite and are not covered by SQLCipher",
          ]
        : [],
  };
}
