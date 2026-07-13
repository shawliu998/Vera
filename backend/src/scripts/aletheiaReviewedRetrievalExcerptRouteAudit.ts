import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

async function request(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: (await response.json()) as Record<string, any> };
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "vera-reviewed-retrieval-route-"),
  );
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "retrieval-route-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "retrieval-route@vera.local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { litigationRouter }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/litigation"),
      ]);
    const repo = createAletheiaRepository();
    const ctx = {
      userId: "retrieval-route-user",
      userEmail: "retrieval-route@vera.local",
    };
    const matter = (await repo.createMatter(ctx, {
      title: "Reviewed retrieval route matter",
      objective: "Verify reviewed excerpt persistence and failure recovery.",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "Route audit",
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: "reviewed_retrieval_excerpt" },
    })) as Record<string, any>;
    const sourceBody =
      "The respondent acknowledged delivery on 10 June 2026. Payment remained outstanding.";
    await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "delivery-record.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(sourceBody, "utf8"),
      buffer: Buffer.from(sourceBody, "utf8"),
    });

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const manifestPath = `/aletheia/matters/${matter.id}/litigation/retrieval-manifests`;

    const missingFocus = await request(baseUrl, manifestPath, {
      method: "POST",
      body: {},
    });
    assert.equal(missingFocus.response.status, 400);

    const created = await request(baseUrl, manifestPath, {
      method: "POST",
      body: { focus: "delivery payment outstanding" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.candidateSetComplete, true);
    assert.equal(created.body.inputBinding, false);
    assert.match(created.body.manifestHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(created.body.candidates.length, 1);

    const loaded = await request(baseUrl, `${manifestPath}/${created.body.id}`);
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.manifestHash, created.body.manifestHash);
    assert.deepEqual(loaded.body.excerpts, []);
    assert.equal(loaded.body.bindingEligibility.eligible, false);

    const excerptPath = `${manifestPath}/${created.body.id}/excerpts`;
    const shortReason = await request(baseUrl, excerptPath, {
      method: "POST",
      body: { chunkId: created.body.candidates[0].chunkId, comment: "short" },
    });
    assert.equal(shortReason.response.status, 400);
    const wrongCandidate = await request(baseUrl, excerptPath, {
      method: "POST",
      body: {
        chunkId: "not-in-manifest",
        comment: "Counsel rejects chunks outside the complete manifest.",
      },
    });
    assert.equal(wrongCandidate.response.status, 400);

    const confirmed = await request(baseUrl, excerptPath, {
      method: "POST",
      body: {
        chunkId: created.body.candidates[0].chunkId,
        comment:
          "Counsel verified the complete chunk against the local source record.",
      },
    });
    assert.equal(confirmed.response.status, 201);
    assert.equal(confirmed.body.status, "confirmed");
    assert.match(confirmed.body.quote_sha256, /^[a-f0-9]{64}$/);

    const reloaded = await request(
      baseUrl,
      `${manifestPath}/${created.body.id}`,
    );
    assert.equal(reloaded.body.excerpts.length, 1);
    assert.equal(reloaded.body.excerpts[0].status, "confirmed");
    assert.equal(reloaded.body.bindingEligibility.eligible, true);
    assert.match(
      reloaded.body.bindingEligibility.bindingHash,
      /^sha256:[a-f0-9]{64}$/,
    );

    const withdrawPath = `/aletheia/matters/${matter.id}/litigation/retrieval-excerpts/${confirmed.body.id}/withdraw`;
    const shortWithdrawal = await request(baseUrl, withdrawPath, {
      method: "POST",
      body: { comment: "short" },
    });
    assert.equal(shortWithdrawal.response.status, 400);
    const withdrawn = await request(baseUrl, withdrawPath, {
      method: "POST",
      body: {
        comment:
          "Counsel withdrew the excerpt before it entered any Agent analysis.",
      },
    });
    assert.equal(withdrawn.response.status, 200);
    assert.equal(withdrawn.body.status, "withdrawn");
    const afterWithdrawal = await request(
      baseUrl,
      `${manifestPath}/${created.body.id}`,
    );
    assert.equal(afterWithdrawal.body.bindingEligibility.eligible, false);
    assert.equal(
      (
        await request(baseUrl, withdrawPath, {
          method: "POST",
          body: {
            comment: "A second withdrawal must not mutate the record again.",
          },
        })
      ).response.status,
      404,
    );

    const stale = await request(baseUrl, manifestPath, {
      method: "POST",
      body: { focus: "delivery payment outstanding" },
    });
    assert.equal(stale.response.status, 201);
    const laterBody = "A later filing changes the matter retrieval index.";
    await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "later-filing.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(laterBody, "utf8"),
      buffer: Buffer.from(laterBody, "utf8"),
    });
    const staleConfirmation = await request(
      baseUrl,
      `${manifestPath}/${stale.body.id}/excerpts`,
      {
        method: "POST",
        body: {
          chunkId: stale.body.candidates[0].chunkId,
          comment:
            "This stale manifest must fail after the document index changes.",
        },
      },
    );
    assert.equal(staleConfirmation.response.status, 400);
    assert.match(
      staleConfirmation.body.detail,
      /documents changed after retrieval/,
    );
    const staleReload = await request(
      baseUrl,
      `${manifestPath}/${stale.body.id}`,
    );
    assert.equal(staleReload.body.bindingEligibility.eligible, false);
    assert.match(
      staleReload.body.bindingEligibility.reason,
      /documents changed after retrieval/,
    );

    const detail = (await repo.getMatterDetail(ctx, matter.id)) as Record<
      string,
      any
    >;
    const actions = new Set(
      detail.auditEvents.map((event: Record<string, unknown>) => event.action),
    );
    assert(actions.has("litigation_retrieval_manifest_created"));
    assert(actions.has("litigation_retrieval_excerpt_confirmed"));
    assert(actions.has("litigation_retrieval_excerpt_withdrawn"));

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-reviewed-retrieval-excerpt-route-v1",
          checks: [
            "authenticated manifest create and reload",
            "complete candidate and hash projection",
            "mandatory confirmation and withdrawal reasons",
            "out-of-manifest candidate rejection",
            "confirmed excerpt persistence and exact quote hash",
            "server-derived Agent input binding eligibility",
            "immutable withdrawal",
            "stale index fail-closed confirmation",
            "matter-scoped audit events",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
