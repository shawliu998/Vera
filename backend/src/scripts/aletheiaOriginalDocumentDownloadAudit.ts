import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

type RecordValue = Record<string, any>;

function record(value: unknown) {
  return value as RecordValue;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function responseJson(response: Response) {
  return (await response.json()) as RecordValue;
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-original-document-download-"),
  );
  const databasePath = path.join(root, "aletheia.db");
  const ownerToken = "original-document-download-owner-token";
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = ownerToken;
  process.env.ALETHEIA_LOCAL_USER_ID = "original-document-owner";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "owner@original.local";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  process.env.ALETHEIA_MALWARE_SCAN_MODE = "disabled";
  process.env.ALETHEIA_CDR_MODE = "disabled";

  let server: http.Server | null = null;
  let database: LocalDatabase | null = null;
  let governance: any = null;
  let identities: any = null;
  try {
    const [
      { LocalAletheiaRepository },
      { LocalGovernanceService },
      { LocalIdentityRepository },
      { aletheiaRouter },
    ] = await Promise.all([
      import("../lib/aletheia/localRepository"),
      import("../lib/aletheia/localGovernance"),
      import("../lib/aletheia/localIdentity"),
      import("../routes/aletheia"),
    ]);
    const owner = {
      userId: "original-document-owner",
      userEmail: "owner@original.local",
    };
    const repository = new LocalAletheiaRepository();
    const createMatter = async (title: string) =>
      record(
        await repository.createMatter(owner, {
          title,
          objective: "Verify original evidence delivery fails closed.",
          template: "legal_matter_review",
          status: "in_progress",
          riskLevel: "high",
          clientOrProject: "Original document audit",
          sourceProjectId: null,
          sharedWith: [],
          metadata: { audit: "original_document_download" },
        }),
      );
    const matter = await createMatter("Original document access");
    const otherMatter = await createMatter("Original document isolation");

    governance = new LocalGovernanceService({
      databasePath,
      multiPrincipalEnabled: true,
    });
    governance.governance(owner.userId, matter.id);
    governance.createPrincipal(owner.userId, {
      id: "original-document-reader",
      displayName: "Original document reader",
      roles: ["counsel"],
    });
    governance.setMatterAcl(
      owner.userId,
      matter.id,
      "original-document-reader",
      "counsel",
    );
    governance.createPrincipal(owner.userId, {
      id: "original-document-foreign",
      displayName: "Original document foreign principal",
      roles: ["reviewer"],
    });
    identities = new LocalIdentityRepository({ databasePath });
    const readerToken = identities.issueToken({
      principalId: "original-document-reader",
      createdBy: owner.userId,
      email: "reader@original.local",
    }).token;
    const foreignToken = identities.issueToken({
      principalId: "original-document-foreign",
      createdBy: owner.userId,
      email: "foreign@original.local",
    }).token;

    const originalBytes = Buffer.from(
      "Original evidence must be exact.\n",
      "utf8",
    );
    const original = record(
      await repository.uploadMatterDocument(owner, matter.id, {
        filename: "evidence \u6848\u4ef6.txt",
        mimeType: "text/plain",
        sizeBytes: originalBytes.length,
        buffer: originalBytes,
      }),
    );
    const originalMetadata = record(original.metadata);
    const originalPath = String(originalMetadata.storagePath);

    const app = express();
    app.use("/aletheia", aletheiaRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const downloadUrl = (matterId: string, documentId: string) =>
      `${baseUrl}/aletheia/matters/${matterId}/documents/${documentId}/original`;
    const download = (
      token: string,
      matterId = matter.id,
      documentId = original.id,
    ) =>
      fetch(downloadUrl(matterId, documentId), {
        headers: bearer(token),
      });
    const assertPathFree = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      assert.equal(text.includes(root), false);
      assert.equal(text.includes(originalPath), false);
      assert.equal(text.includes("storagePath"), false);
      assert.equal(text.includes("derivedStoragePath"), false);
    };
    const assertIntegrityFailure = async () => {
      const response = await download(ownerToken);
      assert.equal(response.status, 409);
      const body = await responseJson(response);
      assert.equal(body.code, "document_original_integrity_failed");
      assertPathFree(body);
    };

    const ownerResponse = await download(ownerToken);
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerResponse.headers.get("content-type"), "text/plain");
    assert.equal(
      ownerResponse.headers.get("content-length"),
      String(originalBytes.length),
    );
    assert.equal(
      ownerResponse.headers.get("x-aletheia-content-sha256"),
      originalMetadata.originalSha256,
    );
    assert.equal(
      ownerResponse.headers.get("access-control-expose-headers"),
      "Content-Disposition, Content-Length, X-Aletheia-Content-SHA256",
    );
    assert.match(
      ownerResponse.headers.get("x-aletheia-content-sha256") ?? "",
      /^[a-f0-9]{64}$/,
    );
    assert.equal(
      ownerResponse.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(ownerResponse.headers.get("pragma"), "no-cache");
    assert.equal(
      ownerResponse.headers.get("x-content-type-options"),
      "nosniff",
    );
    assert.equal(
      ownerResponse.headers.get("content-security-policy"),
      "sandbox",
    );
    assert.equal(ownerResponse.headers.get("accept-ranges"), "none");
    const disposition = ownerResponse.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment; filename="[^"]+\.txt";/);
    assert.match(disposition, /filename\*=UTF-8''/);
    assert.equal(disposition.includes("\r"), false);
    assert.equal(disposition.includes("\n"), false);
    for (const [, value] of ownerResponse.headers) assertPathFree(value);
    const deliveredBytes = Buffer.from(await ownerResponse.arrayBuffer());
    assert.deepEqual(deliveredBytes, originalBytes);
    assertPathFree(deliveredBytes.toString("utf8"));

    const rangeResponse = await fetch(downloadUrl(matter.id, original.id), {
      headers: { ...bearer(ownerToken), range: "bytes=0-1" },
    });
    assert.equal(rangeResponse.status, 200);
    assert.deepEqual(
      Buffer.from(await rangeResponse.arrayBuffer()),
      originalBytes,
    );

    const readerResponse = await download(readerToken);
    assert.equal(readerResponse.status, 200);
    assert.deepEqual(
      Buffer.from(await readerResponse.arrayBuffer()),
      originalBytes,
    );
    const foreignResponse = await download(foreignToken);
    assert.equal(foreignResponse.status, 404);
    assertPathFree(await foreignResponse.text());
    const crossMatterResponse = await download(ownerToken, otherMatter.id);
    assert.equal(crossMatterResponse.status, 404);
    assertPathFree(await crossMatterResponse.text());

    database = new LocalDatabase(databasePath);
    const setMetadata = (metadata: RecordValue) => {
      database!
        .prepare(
          "update aletheia_matter_documents set metadata = ? where id = ?",
        )
        .run(JSON.stringify(metadata), original.id);
    };
    const restoredMetadata = () => JSON.parse(JSON.stringify(originalMetadata));

    chmodSync(originalPath, 0o600);
    writeFileSync(originalPath, "tampered plaintext", { mode: 0o600 });
    await assertIntegrityFailure();
    writeFileSync(originalPath, originalBytes, { mode: 0o400 });

    const hashMetadata = restoredMetadata();
    hashMetadata.originalSha256 = "0".repeat(64);
    setMetadata(hashMetadata);
    await assertIntegrityFailure();

    const escapedPathMetadata = restoredMetadata();
    escapedPathMetadata.storagePath = path.join(root, "outside.txt");
    setMetadata(escapedPathMetadata);
    await assertIntegrityFailure();

    setMetadata(restoredMetadata());
    const outsidePath = path.join(root, "outside.txt");
    writeFileSync(outsidePath, originalBytes, { mode: 0o600 });
    unlinkSync(originalPath);
    symlinkSync(outsidePath, originalPath);
    await assertIntegrityFailure();
    unlinkSync(originalPath);
    writeFileSync(originalPath, originalBytes, { mode: 0o400 });

    const rejectedMimeMetadata = restoredMetadata();
    rejectedMimeMetadata.mimeType = "application/octet-stream";
    setMetadata(rejectedMimeMetadata);
    await assertIntegrityFailure();
    setMetadata(restoredMetadata());

    process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
    process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
    process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString(
      "base64",
    );
    const encrypted = record(
      await repository.uploadMatterDocument(owner, matter.id, {
        filename: "encrypted.txt",
        mimeType: "text/plain",
        sizeBytes: 18,
        buffer: Buffer.from("encrypted evidence\n"),
      }),
    );
    const encryptedPath = String(record(encrypted.metadata).storagePath);
    const ciphertext = readFileSync(encryptedPath);
    ciphertext[ciphertext.length - 1] ^= 0xff;
    chmodSync(encryptedPath, 0o600);
    writeFileSync(encryptedPath, ciphertext, { mode: 0o600 });
    const ciphertextFailure = await fetch(
      downloadUrl(matter.id, encrypted.id),
      {
        headers: bearer(ownerToken),
      },
    );
    assert.equal(ciphertextFailure.status, 409);
    assertPathFree(await ciphertextFailure.text());

    process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
    const auditCountBefore = Number(
      (
        database
          .prepare(
            "select count(*) as count from aletheia_audit_events where action = 'matter_document_original_downloaded'",
          )
          .get() as { count: number }
      ).count,
    );
    database.exec(`create trigger fail_original_document_download_audit
      before insert on aletheia_audit_events
      when new.action = 'matter_document_original_downloaded'
      begin select raise(abort, 'forced original document audit failure'); end;`);
    const auditFailure = await download(ownerToken);
    assert.equal(auditFailure.status, 503);
    const auditFailureBody = await responseJson(auditFailure);
    assert.equal(auditFailureBody.code, "document_original_audit_failed");
    assertPathFree(auditFailureBody);
    assert.equal(
      Buffer.from(JSON.stringify(auditFailureBody)).includes(originalBytes),
      false,
    );
    const auditCountAfterFailure = Number(
      (
        database
          .prepare(
            "select count(*) as count from aletheia_audit_events where action = 'matter_document_original_downloaded'",
          )
          .get() as { count: number }
      ).count,
    );
    assert.equal(auditCountAfterFailure, auditCountBefore);
    database.exec("drop trigger fail_original_document_download_audit");

    const auditRows = database
      .prepare(
        `select user_id, details, sequence, previous_hash, event_hash
           from aletheia_audit_events
          where matter_id = ? and action = 'matter_document_original_downloaded'
          order by sequence asc`,
      )
      .all(matter.id) as Array<RecordValue>;
    assert.ok(auditRows.length >= 2);
    const readerAudit = auditRows.find(
      (row) => JSON.parse(row.details).actorId === "original-document-reader",
    );
    assert(readerAudit);
    assert.equal(JSON.parse(readerAudit.details).independentActor, true);
    assert.equal(JSON.parse(readerAudit.details).crossPrincipal, true);
    for (const row of auditRows) {
      const details = JSON.parse(row.details) as RecordValue;
      assert.equal(details.documentId, original.id);
      assert.equal(details.originalSha256, originalMetadata.originalSha256);
      assert.equal(details.bytes, originalBytes.length);
      assert.match(String(row.event_hash), /^hmac-sha256:[a-f0-9]{64}$/);
      assertPathFree(details);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-original-document-download-v1",
          checks: [
            "owner and ACL reader original access",
            "inaccessible and cross-matter 404 denial",
            "plaintext, ciphertext, hash, MIME, metadata, and symlink integrity failures",
            "HMAC-chained path-free original-access audit",
            "audit append failure returns no document bytes",
            "private no-store attachment headers and no range support",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (server) await closeServer(server);
    database?.close();
    identities?.close();
    governance?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-original-document-download-audit] failed", error);
  process.exitCode = 1;
});
