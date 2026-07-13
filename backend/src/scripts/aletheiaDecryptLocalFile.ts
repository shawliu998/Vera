import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  readProtectedLocalFileSync,
  type LocalFilePurpose,
} from "../lib/aletheia/localEnvelopeCrypto";

const input = process.env.ALETHEIA_RECOVERY_INPUT?.trim();
const output = process.env.ALETHEIA_RECOVERY_OUTPUT?.trim();
const configuredPurpose = process.env.ALETHEIA_RECOVERY_PURPOSE?.trim();
if (!input || !output) {
  throw new Error(
    "Set ALETHEIA_RECOVERY_INPUT and ALETHEIA_RECOVERY_OUTPUT. Recovery never prints plaintext to stdout.",
  );
}
const source = path.resolve(input);
const destination = path.resolve(output);
if (source === destination)
  throw new Error("Recovery output must differ from the encrypted input.");
const dataDir = path.resolve(
  process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia"),
);
const destinationRelative = path.relative(dataDir, destination);
if (
  destinationRelative === "" ||
  (!destinationRelative.startsWith("..") &&
    !path.isAbsolute(destinationRelative))
) {
  throw new Error(
    "Recovery output must be outside ALETHEIA_DATA_DIR to avoid introducing unmanaged plaintext into the vault.",
  );
}
if (
  existsSync(destination) &&
  process.env.ALETHEIA_RECOVERY_OVERWRITE !== "true"
) {
  throw new Error(
    "Recovery output already exists. Set ALETHEIA_RECOVERY_OVERWRITE=true only after reviewing the destination.",
  );
}
const purpose: LocalFilePurpose =
  configuredPurpose === "source_document" ||
  configuredPurpose === "local_export"
    ? configuredPurpose
    : source.split(path.sep).includes("documents")
      ? "source_document"
      : source.split(path.sep).includes("exports")
        ? "local_export"
        : (() => {
            throw new Error(
              "Unable to infer file purpose; set ALETHEIA_RECOVERY_PURPOSE=source_document or local_export.",
            );
          })();
const plaintext = readProtectedLocalFileSync({ filePath: source, purpose });
const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
try {
  writeFileSync(temporary, plaintext, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
} catch (error) {
  try {
    unlinkSync(temporary);
  } catch {
    // The output may not have been created.
  }
  throw error;
}
console.log(
  JSON.stringify({
    schema_version: "aletheia-local-file-recovery-v1",
    input: source,
    output: destination,
    purpose,
    plaintext_bytes: plaintext.length,
  }),
);
