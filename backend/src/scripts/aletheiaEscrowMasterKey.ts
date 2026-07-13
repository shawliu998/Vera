import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadApplicationMasterKey } from "../lib/aletheia/localEnvelopeCrypto";

const output = process.env.ALETHEIA_KEY_ESCROW_OUTPUT?.trim();
if (!output)
  throw new Error(
    "Set ALETHEIA_KEY_ESCROW_OUTPUT to an explicit secure destination.",
  );
if (process.env.ALETHEIA_KEY_ESCROW_CONFIRM !== "export-master-key") {
  throw new Error(
    "Set ALETHEIA_KEY_ESCROW_CONFIRM=export-master-key after confirming the destination is encrypted, access-controlled operator escrow.",
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
    "The application master key must not be escrowed inside ALETHEIA_DATA_DIR.",
  );
}
if (existsSync(destination))
  throw new Error("Refusing to overwrite an existing escrow file.");
const key = loadApplicationMasterKey();
const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
try {
  writeFileSync(temporary, key, { flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
} catch (error) {
  try {
    unlinkSync(temporary);
  } catch {
    // The temporary file may not have been created.
  }
  throw error;
}
console.log(
  JSON.stringify({
    schema_version: "aletheia-master-key-escrow-v1",
    output: destination,
    bytes: key.length,
    warning:
      "Store this file only in encrypted, access-controlled operator escrow; it decrypts all files protected by this master key.",
  }),
);
