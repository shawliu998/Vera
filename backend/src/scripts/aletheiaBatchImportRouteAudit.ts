import "dotenv/config";
import express from "express";
import { rmSync } from "node:fs";
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

async function main() {
  const dataDir = path.join(
    os.tmpdir(),
    `aletheia-batch-import-route-${Date.now()}`,
  );
  rmSync(dataDir, { recursive: true, force: true });
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "batch-route-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "batch-route@aletheia.internal";

  const [{ createAletheiaRepository }, { aletheiaRouter }] = await Promise.all([
    import("../lib/aletheia"),
    import("../routes/aletheia"),
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

    console.log(
      JSON.stringify(
        {
          ok: true,
          matterId: matter.id,
          imported: batchPayload.imported,
          sourceIndexDocuments: sourceIndex.documents.length,
          sourceIndexChunks: sourceIndex.chunks.length,
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
