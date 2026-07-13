import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  applicationEncryptionMode,
  isAletheiaEnvelope,
  loadApplicationMasterKey,
  readProtectedLocalFileSync,
  writeProtectedLocalFileSync,
  type LocalFilePurpose,
} from "./localEnvelopeCrypto";

export type EncryptionMigrationEntry = {
  file_path: string;
  purpose: LocalFilePurpose;
  status: "would_encrypt" | "encrypted" | "already_encrypted";
  plaintext_bytes?: number;
};

function filesBelow(root: string) {
  const files: string[] = [];
  const visit = (candidate: string) => {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic link during encryption migration: ${candidate}`,
      );
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(candidate))
        visit(path.join(candidate, name));
      return;
    }
    if (stats.isFile()) files.push(candidate);
  };
  try {
    visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files.sort();
}

export function migrateLegacyLocalFiles(args: {
  dataDir: string;
  apply: boolean;
}) {
  if (applicationEncryptionMode() !== "required") {
    throw new Error(
      "Encryption migration requires ALETHEIA_APPLICATION_ENCRYPTION=required.",
    );
  }
  // Resolve the independent key before inspecting or mutating any file.
  loadApplicationMasterKey();
  const dataDir = path.resolve(args.dataDir);
  const candidates: Array<{ filePath: string; purpose: LocalFilePurpose }> = [
    ...filesBelow(path.join(dataDir, "documents")).map((filePath) => ({
      filePath,
      purpose: "source_document" as const,
    })),
    ...filesBelow(path.join(dataDir, "exports"))
      .filter(
        (filePath) =>
          !path
            .relative(path.join(dataDir, "exports"), filePath)
            .split(path.sep)
            .includes("local-packages"),
      )
      .map((filePath) => ({
        filePath,
        purpose: "local_export" as const,
      })),
  ];
  const entries: EncryptionMigrationEntry[] = [];
  const legacy: Array<{
    filePath: string;
    purpose: LocalFilePurpose;
    plaintextBytes: number;
    sha256: string;
  }> = [];
  for (const candidate of candidates) {
    const current = readFileSync(candidate.filePath);
    if (isAletheiaEnvelope(current)) {
      // Authentication is part of migration preflight, including on an idempotent rerun.
      readProtectedLocalFileSync(candidate);
      entries.push({
        file_path: candidate.filePath,
        purpose: candidate.purpose,
        status: "already_encrypted",
      });
      continue;
    }
    legacy.push({
      ...candidate,
      plaintextBytes: current.length,
      sha256: createHash("sha256").update(current).digest("hex"),
    });
    if (!args.apply) {
      entries.push({
        file_path: candidate.filePath,
        purpose: candidate.purpose,
        status: "would_encrypt",
        plaintext_bytes: current.length,
      });
    }
  }
  for (const candidate of args.apply ? legacy : []) {
    const current = readFileSync(candidate.filePath);
    if (
      current.length !== candidate.plaintextBytes ||
      createHash("sha256").update(current).digest("hex") !== candidate.sha256
    ) {
      throw new Error(
        `Refusing to encrypt a file that changed during migration preflight: ${candidate.filePath}`,
      );
    }
    writeProtectedLocalFileSync({
      filePath: candidate.filePath,
      plaintext: current,
      purpose: candidate.purpose,
    });
    entries.push({
      file_path: candidate.filePath,
      purpose: candidate.purpose,
      status: "encrypted",
      plaintext_bytes: candidate.plaintextBytes,
    });
  }
  return {
    schema_version: "aletheia-local-file-encryption-migration-v1",
    applied: args.apply,
    data_dir: dataDir,
    counts: {
      total: entries.length,
      encrypted: entries.filter((entry) => entry.status === "encrypted").length,
      would_encrypt: entries.filter((entry) => entry.status === "would_encrypt")
        .length,
      already_encrypted: entries.filter(
        (entry) => entry.status === "already_encrypted",
      ).length,
    },
    entries,
  };
}
