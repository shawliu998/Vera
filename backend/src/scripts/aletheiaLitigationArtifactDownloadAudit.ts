import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

type AnyRecord = Record<string, any>;

function record(value: unknown) {
  return value as AnyRecord;
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestDownload(args: {
  baseUrl: string;
  matterId: string;
  exportId: string;
  token?: string;
}) {
  return fetch(
    `${args.baseUrl}/aletheia/matters/${args.matterId}/litigation/exports/${args.exportId}/download`,
    {
      headers: args.token
        ? { authorization: `Bearer ${args.token}` }
        : undefined,
    },
  );
}

async function responseJson(response: Response) {
  return (await response.json()) as AnyRecord;
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-litigation-download-audit-"),
  );
  const databasePath = path.join(dataDir, "aletheia.db");
  const ownerToken = randomBytes(32).toString("hex");
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = ownerToken;
  process.env.ALETHEIA_LOCAL_USER_ID = "litigation-download-owner";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "owner@download.local";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 17).toString(
    "base64",
  );
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [
      { LocalAletheiaRepository },
      { LocalGovernanceService },
      { LocalIdentityRepository },
      { litigationRouter },
    ] = await Promise.all([
      import("../lib/aletheia/localRepository"),
      import("../lib/aletheia/localGovernance"),
      import("../lib/aletheia/localIdentity"),
      import("../routes/litigation"),
    ]);
    const repository = new LocalAletheiaRepository();
    const owner = {
      userId: "litigation-download-owner",
      userEmail: "owner@download.local",
    };
    const createMatter = async (title: string) =>
      record(
        await repository.createMatter(owner, {
          title,
          objective: "Verify protected litigation artifact delivery.",
          template: "civil_litigation",
          status: "in_progress",
          riskLevel: "high",
          clientOrProject: "Download audit",
          sourceProjectId: null,
          sharedWith: [],
          metadata: { audit: "litigation_artifact_download" },
        }),
      );
    const matter = await createMatter("Protected artifact download");
    const otherMatter = await createMatter("Wrong matter boundary");
    const artifact = record(
      await repository.generateLitigationArtifact(
        owner,
        matter.id,
        "hearing_plan",
      ),
    );
    const governance = new LocalGovernanceService({ databasePath });
    governance.governance(owner.userId, matter.id);
    governance.createPrincipal(owner.userId, {
      id: "litigation-download-approver",
      displayName: "Litigation download approver",
      roles: ["reviewer"],
    });
    governance.setMatterAcl(
      owner.userId,
      matter.id,
      "litigation-download-approver",
      "reviewer",
    );
    governance.setApprovalPolicy(owner.userId, matter.id, {
      action: "litigation_artifact_export",
      requiredApprovals: 1,
      eligibleRoles: ["reviewer"],
      prohibitRequester: true,
      enabled: true,
    });
    const checkpoint = record(
      await repository.requestApproval(owner, matter.id, {
        action: "litigation_artifact_export",
        prompt: "Approve the exact hearing plan for protected download.",
        requestedPayload: {
          workProductId: artifact.id,
          version: artifact.version,
          contentHash: artifact.content_hash,
        },
      }),
    );
    await repository.decideApproval(
      { userId: "litigation-download-approver" },
      matter.id,
      checkpoint.id,
      {
        decision: "approved",
        comment: "Approved for the encrypted download audit.",
      },
    );
    const exported = record(
      await repository.exportLitigationArtifact(
        owner,
        matter.id,
        artifact.id,
        checkpoint.id,
        "docx",
      ),
    );
    const encryptedBytes = readFileSync(exported.exportPath);
    assert.equal(
      encryptedBytes.subarray(0, 12).toString("ascii"),
      "ALETHEIAENC\0",
    );
    assert.notEqual(encryptedBytes.subarray(0, 2).toString("ascii"), "PK");

    governance.createPrincipal(owner.userId, {
      id: "litigation-download-foreign",
      displayName: "Foreign download principal",
      roles: ["reviewer"],
    });
    const identities = new LocalIdentityRepository({ databasePath });
    const foreignToken = identities.issueToken({
      principalId: "litigation-download-foreign",
      createdBy: owner.userId,
      label: "Foreign download boundary",
      email: "foreign@download.local",
      expiresInSeconds: 3_600,
    }).token;

    const app = express();
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthenticated = await requestDownload({
      baseUrl,
      matterId: matter.id,
      exportId: exported.exportId,
    });
    assert.equal(unauthenticated.status, 401);

    const wrongMatter = await requestDownload({
      baseUrl,
      matterId: otherMatter.id,
      exportId: exported.exportId,
      token: ownerToken,
    });
    assert.equal(wrongMatter.status, 404);

    const wrongUser = await requestDownload({
      baseUrl,
      matterId: matter.id,
      exportId: exported.exportId,
      token: foreignToken,
    });
    assert.equal(wrongUser.status, 403);

    const database = new LocalDatabase(databasePath);
    database
      .prepare(
        "update aletheia_human_checkpoints set status = 'rejected' where id = ?",
      )
      .run(checkpoint.id);
    const unapproved = await requestDownload({
      baseUrl,
      matterId: matter.id,
      exportId: exported.exportId,
      token: ownerToken,
    });
    assert.equal(unapproved.status, 409);
    assert.equal((await responseJson(unapproved)).code, "approval_required");
    database
      .prepare(
        "update aletheia_human_checkpoints set status = 'approved' where id = ?",
      )
      .run(checkpoint.id);
    database
      .prepare("update aletheia_work_products set title = ? where id = ?")
      .run("Hearing plan\r\nX-Injected: unsafe / 案件", artifact.id);

    const downloaded = await requestDownload({
      baseUrl,
      matterId: matter.id,
      exportId: exported.exportId,
      token: ownerToken,
    });
    assert.equal(downloaded.status, 200);
    assert.equal(
      downloaded.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
    const disposition = downloaded.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment; filename="[^"]+\.docx";/);
    assert.match(disposition, /filename\*=UTF-8''/);
    assert.equal(disposition.includes("\r"), false);
    assert.equal(disposition.includes("\n"), false);
    assert.equal(disposition.includes("X-Injected:"), false);
    for (const [, value] of downloaded.headers) {
      assert.equal(value.includes(dataDir), false);
      assert.equal(value.includes(exported.exportPath), false);
    }
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(downloadedBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(downloadedBytes.includes(Buffer.from(dataDir)), false);
    const docx = await JSZip.loadAsync(downloadedBytes);
    assert(docx.file("[Content_Types].xml"));
    assert(docx.file("word/document.xml"));

    const downloadAudit = database
      .prepare(
        `select details from aletheia_audit_events
          where matter_id = ? and action = 'litigation_artifact_downloaded'
          order by created_at desc limit 1`,
      )
      .get(matter.id) as { details?: string } | undefined;
    const auditDetails = JSON.parse(
      downloadAudit?.details ?? "{}",
    ) as AnyRecord;
    assert.equal(auditDetails.exportId, exported.exportId);
    assert.equal("exportPath" in auditDetails, false);

    const tamperedBytes = Buffer.from(encryptedBytes);
    tamperedBytes[tamperedBytes.length - 20] ^= 0xff;
    writeFileSync(exported.exportPath, tamperedBytes, { mode: 0o600 });
    const tampered = await requestDownload({
      baseUrl,
      matterId: matter.id,
      exportId: exported.exportId,
      token: ownerToken,
    });
    assert.equal(tampered.status, 409);
    assert.equal(
      (await responseJson(tampered)).code,
      "export_integrity_failed",
    );
    database.close();

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-litigation-artifact-download-v1",
          checks: [
            "private-token authentication required",
            "matter boundary and ACL enforcement",
            "multi-principal governance approval revalidated",
            "approved checkpoint revalidated",
            "encrypted envelope decrypted to valid OOXML DOCX",
            "safe attachment content disposition",
            "local export path not exposed",
            "tampered ciphertext fails closed",
            "path-free download audit event persisted",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (server) await closeServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-litigation-artifact-download-audit] failed", error);
  process.exitCode = 1;
});
