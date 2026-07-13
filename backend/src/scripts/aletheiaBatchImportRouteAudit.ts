import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function uploadTempNames(uploadTempRoot: string) {
  await mkdir(uploadTempRoot, { recursive: true, mode: 0o700 });
  return new Set(await readdir(uploadTempRoot));
}

async function assertNoNewUploadTemps(
  uploadTempRoot: string,
  before: ReadonlySet<string>,
  context: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const after = await uploadTempNames(uploadTempRoot);
    const leaked = [...after].filter((name) => !before.has(name));
    if (leaked.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(false, `${context} leaked temporary upload files`);
}

async function main() {
  const dataDir = path.join(
    os.tmpdir(),
    `aletheia-batch-import-route-${Date.now()}`,
  );
  rmSync(dataDir, { recursive: true, force: true });
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "batch-route-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "batch-route@aletheia.internal";

  const [
    { createAletheiaRepository },
    { aletheiaRouter },
    { UPLOAD_TEMP_ROOT, cleanupStaleUploadedFiles },
  ] = await Promise.all([
    import("../lib/aletheia"),
    import("../routes/aletheia"),
    import("../lib/upload"),
  ]);

  const ctx = {
    userId: "batch-route-user",
    userEmail: "batch-route@aletheia.internal",
  };
  const repo = createAletheiaRepository();
  const matter: any = await repo.createMatter(ctx, {
    title: "Aletheia Batch Import Route Audit",
    objective: "Verify batch import route creates source-indexed documents.",
    template: "legal_matter_review",
    status: "draft",
    riskLevel: "medium",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { audit: "batch_import_route" },
  });

  const app = express();
  app.use("/aletheia", aletheiaRouter);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object", "Server should listen");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const form = new FormData();
    form.append(
      "files",
      new Blob(["First batch source requires a 10 day notice period."], {
        type: "text/plain",
      }),
      "batch-notice.txt",
    );
    form.append(
      "files",
      new Blob(["Second batch source confirms escrow release obligations."], {
        type: "text/plain",
      }),
      "batch-escrow.txt",
    );

    const batchResponse = await fetch(
      `${baseUrl}/aletheia/matters/${matter.id}/documents/batch`,
      { method: "POST", body: form },
    );
    assert(
      batchResponse.status === 201,
      `Batch route should return 201, got ${batchResponse.status}`,
    );
    const batchPayload: any = await batchResponse.json();
    assert(
      batchPayload.total === 2,
      "Batch route should count submitted files",
    );
    assert(batchPayload.imported === 2, "Batch route should import both files");
    assert(batchPayload.failed === 0, "Batch route should have no failures");
    assert(
      batchPayload.documents.every(
        (document: any) => document.parsed_status === "parsed",
      ),
      "Batch route should return parsed document records",
    );

    const sourceIndexResponse = await fetch(
      `${baseUrl}/aletheia/matters/${matter.id}/v1/source-index?includeChunks=true&chunkLimit=10`,
    );
    assert(
      sourceIndexResponse.status === 200,
      `Source index route should return 200, got ${sourceIndexResponse.status}`,
    );
    const sourceIndex: any = await sourceIndexResponse.json();
    assert(
      sourceIndex.documents.length === 2,
      "Source index should include both batch-imported documents",
    );
    assert(
      sourceIndex.chunks.length === 2,
      "Source index should include chunks for both batch-imported documents",
    );

    const beforeMissingMatter = await uploadTempNames(UPLOAD_TEMP_ROOT);
    const missingMatterForm = new FormData();
    missingMatterForm.append(
      "files",
      new Blob(["First file for a missing matter."], { type: "text/plain" }),
      "missing-first.txt",
    );
    missingMatterForm.append(
      "files",
      new Blob(["Second file must also be cleaned."], { type: "text/plain" }),
      "missing-second.txt",
    );
    const missingMatterResponse = await fetch(
      `${baseUrl}/aletheia/matters/missing-matter/documents/batch`,
      { method: "POST", body: missingMatterForm },
    );
    assert(
      missingMatterResponse.status === 404,
      `Missing matter batch should return 404, got ${missingMatterResponse.status}`,
    );
    await assertNoNewUploadTemps(
      UPLOAD_TEMP_ROOT,
      beforeMissingMatter,
      "Early batch return",
    );

    const beforeMulterError = await uploadTempNames(UPLOAD_TEMP_ROOT);
    const tooManyFilesForm = new FormData();
    for (let index = 0; index < 101; index += 1) {
      tooManyFilesForm.append(
        "files",
        new Blob([`File ${index}`], { type: "text/plain" }),
        `too-many-${index}.txt`,
      );
    }
    const tooManyFilesResponse = await fetch(
      `${baseUrl}/aletheia/matters/${matter.id}/documents/batch`,
      { method: "POST", body: tooManyFilesForm },
    );
    assert(
      tooManyFilesResponse.status === 400,
      `Multer file-count error should return 400, got ${tooManyFilesResponse.status}`,
    );
    await assertNoNewUploadTemps(
      UPLOAD_TEMP_ROOT,
      beforeMulterError,
      "Multer error",
    );

    const staleName = randomUUID();
    const freshName = randomUUID();
    const stalePath = path.join(UPLOAD_TEMP_ROOT, staleName);
    const freshPath = path.join(UPLOAD_TEMP_ROOT, freshName);
    await Promise.all([
      writeFile(stalePath, "stale", { mode: 0o600 }),
      writeFile(freshPath, "fresh", { mode: 0o600 }),
    ]);
    const now = Date.now();
    const oldDate = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(stalePath, oldDate, oldDate);
    await cleanupStaleUploadedFiles({ now, ttlMs: 60 * 60 * 1000 });
    assert(!existsSync(stalePath), "Janitor should remove stale upload temp");
    assert(existsSync(freshPath), "Janitor should preserve fresh upload temp");
    await rm(freshPath, { force: true });

    console.log(
      JSON.stringify(
        {
          ok: true,
          matterId: matter.id,
          imported: batchPayload.imported,
          sourceIndexDocuments: sourceIndex.documents.length,
          sourceIndexChunks: sourceIndex.chunks.length,
          multerErrorCleanup: true,
          earlyReturnCleanup: true,
          staleTempJanitor: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
