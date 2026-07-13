import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const KEYCHAIN_SERVICE = "com.aletheia.desktop.database-encryption";
const KEYCHAIN_ACCOUNT = "aletheia-local-database-key";
let keychainCache: Buffer | null = null;

export class LocalDatabaseKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDatabaseKeyError";
  }
}

function dataDir() {
  return path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  );
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function decodeKey(value: Buffer | string, source: string) {
  if (Buffer.isBuffer(value) && value.length === KEY_BYTES) {
    return Buffer.from(value);
  }
  const text = Buffer.isBuffer(value)
    ? value.toString("utf8").trim()
    : value.trim();
  const key = /^[0-9a-f]{64}$/i.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (key.length !== KEY_BYTES) {
    throw new LocalDatabaseKeyError(
      `${source} must contain exactly 32 random bytes encoded as base64, 64 hexadecimal characters, or raw bytes.`,
    );
  }
  return key;
}

function keyFromFile(filePath: string) {
  const resolved = path.resolve(filePath);
  if (lstatSync(resolved).isSymbolicLink()) {
    throw new LocalDatabaseKeyError(
      "ALETHEIA_DATABASE_KEY_FILE must not be a symbolic link.",
    );
  }
  const stats = statSync(resolved);
  if (!stats.isFile()) {
    throw new LocalDatabaseKeyError(
      "ALETHEIA_DATABASE_KEY_FILE must point to a regular file.",
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new LocalDatabaseKeyError(
      "ALETHEIA_DATABASE_KEY_FILE must be owner-only (0600).",
    );
  }
  const root = dataDir();
  const canonicalRoot = existsSync(root) ? realpathSync(root) : root;
  if (isPathInside(canonicalRoot, realpathSync(resolved))) {
    throw new LocalDatabaseKeyError(
      "The SQLCipher database key must be stored outside ALETHEIA_DATA_DIR.",
    );
  }
  return decodeKey(readFileSync(resolved), "ALETHEIA_DATABASE_KEY_FILE");
}

function keyFromMacOsKeychain() {
  if (process.platform !== "darwin") {
    throw new LocalDatabaseKeyError(
      "The macos_keychain database-key source is available only on macOS.",
    );
  }
  if (keychainCache) return Buffer.from(keychainCache);
  try {
    const value = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    const key = decodeKey(value, "macOS Keychain database key");
    keychainCache = Buffer.from(key);
    return key;
  } catch (error) {
    throw new LocalDatabaseKeyError(
      `Unable to load the SQLCipher key from macOS Keychain (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

export function loadLocalDatabaseKey() {
  const source = process.env.ALETHEIA_DATABASE_KEY_SOURCE?.trim().toLowerCase();
  if (!source || source === "env") {
    const configured = process.env.ALETHEIA_DATABASE_KEY_BASE64?.trim();
    if (!configured) {
      throw new LocalDatabaseKeyError(
        "SQLCipher is required but ALETHEIA_DATABASE_KEY_BASE64 is missing. No default database key is embedded.",
      );
    }
    return decodeKey(configured, "ALETHEIA_DATABASE_KEY_BASE64");
  }
  if (source === "file") {
    const filePath = process.env.ALETHEIA_DATABASE_KEY_FILE?.trim();
    if (!filePath) {
      throw new LocalDatabaseKeyError(
        "ALETHEIA_DATABASE_KEY_SOURCE=file requires ALETHEIA_DATABASE_KEY_FILE.",
      );
    }
    return keyFromFile(filePath);
  }
  if (source === "macos_keychain") return keyFromMacOsKeychain();
  throw new LocalDatabaseKeyError(
    "ALETHEIA_DATABASE_KEY_SOURCE must be env, file, or macos_keychain.",
  );
}

export function storeLocalDatabaseKeyInMacOsKeychain(key: Buffer) {
  if (process.platform !== "darwin") {
    throw new LocalDatabaseKeyError(
      "SQLCipher key import into macOS Keychain is available only on macOS.",
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new LocalDatabaseKeyError(
      "Only an exact 32-byte SQLCipher key can be imported.",
    );
  }
  try {
    execFileSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
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
    keychainCache = Buffer.from(key);
  } catch (error) {
    throw new LocalDatabaseKeyError(
      `Unable to import the SQLCipher key into macOS Keychain (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

export function localDatabaseKeyId(key = loadLocalDatabaseKey()) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function localDatabaseKeySource() {
  const source = process.env.ALETHEIA_DATABASE_KEY_SOURCE?.trim().toLowerCase();
  return source === "file" || source === "macos_keychain" ? source : "env";
}
