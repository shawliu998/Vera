import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadLocalDatabaseKey } from "../lib/aletheia/localDatabaseKey";

const output = process.env.ALETHEIA_DATABASE_KEY_ESCROW_OUTPUT?.trim();
if (!output) {
  throw new Error(
    "Set ALETHEIA_DATABASE_KEY_ESCROW_OUTPUT to protected operator escrow.",
  );
}
if (
  process.env.ALETHEIA_DATABASE_KEY_ESCROW_CONFIRM !== "export-database-key"
) {
  throw new Error(
    "Set ALETHEIA_DATABASE_KEY_ESCROW_CONFIRM=export-database-key after confirming the destination is separately encrypted and access controlled.",
  );
}
const destination = path.resolve(output);
const dataDir = path.resolve(
  process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia"),
);
const relative = path.relative(dataDir, destination);
if (
  relative === "" ||
  (!relative.startsWith("..") && !path.isAbsolute(relative))
) {
  throw new Error(
    "The SQLCipher key must not be escrowed inside ALETHEIA_DATA_DIR.",
  );
}
if (existsSync(destination))
  throw new Error("Refusing to overwrite an existing escrow file.");
const key = loadLocalDatabaseKey();
const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
try {
  writeFileSync(temporary, key, { flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
} catch (error) {
  if (existsSync(temporary)) unlinkSync(temporary);
  throw error;
}
console.log(
  JSON.stringify({
    schema_version: "aletheia-database-key-escrow-v1",
    output: destination,
    bytes: key.length,
    warning:
      "This file decrypts the SQLCipher database. Store it separately from data backups in encrypted operator escrow.",
  }),
);
