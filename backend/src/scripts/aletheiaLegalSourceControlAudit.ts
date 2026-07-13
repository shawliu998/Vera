import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type RequestHandler } from "express";
import {
  LocalControlError,
  LocalControlRepository,
  readLocalLegalSourceCredential,
} from "../lib/aletheia/localControlRepository";
import type { SecretCipher } from "../lib/aletheia/localSecretCipher";
import { createAletheiaLocalControlRouter } from "../routes/aletheiaLocalControl";

class AuditCipher implements SecretCipher {
  private readonly records = new Map<
    string,
    { plaintext: string; context: string }
  >();
  private failContexts = new Set<string>();
  private sequence = 0;

  encrypt(plaintext: string, context: string) {
    const envelope = `audit-ciphertext-${++this.sequence}`;
    this.records.set(envelope, { plaintext, context });
    return envelope;
  }

  decrypt(envelope: string, context: string) {
    if (this.failContexts.has(context))
      throw new Error("audit cipher unavailable");
    const record = this.records.get(envelope);
    if (!record || record.context !== context)
      throw new Error("audit cipher mismatch");
    return record.plaintext;
  }

  failFor(userId: string, provider: string) {
    this.failContexts.add(`provider-secret:${userId}:${provider}`);
  }
}

async function request(
  base: string,
  method: string,
  url: string,
  body?: unknown,
) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

function assertLocalControlError(
  action: () => unknown,
  code: LocalControlError["code"],
) {
  assert.throws(action, (error: unknown) => {
    return error instanceof LocalControlError && error.code === code;
  });
}

async function main() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-legal-source-control-audit-"),
  );
  process.env.ALETHEIA_DATA_DIR = directory;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 91).toString(
    "base64",
  );
  process.env.VERA_PKULAW_API_ENDPOINT = "https://api.pkulaw.example/research";
  process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "api.pkulaw.example";
  process.env.VERA_PKULAW_API_CREDENTIAL_REF = "pkulaw-local-credential";
  process.env.VERA_WOLTERS_API_ENDPOINT = "https://api.wolters.example/research";
  process.env.VERA_WOLTERS_API_ALLOWED_HOSTS = "api.wolters.example";
  process.env.VERA_WOLTERS_API_CREDENTIAL_REF = "wolters-local-credential";

  const userId = "legal-source-control-audit-user";
  const cipher = new AuditCipher();
  const repository = new LocalControlRepository({
    databasePath: path.join(directory, "aletheia.db"),
    cipher,
  });
  const auth: RequestHandler = (_req, res, next) => {
    res.locals.userId = userId;
    next();
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/aletheia",
    createAletheiaLocalControlRouter({
      repository,
      auth,
      runtimeModels: () => [],
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const secrets = {
    pkulaw: "pkulaw-local-credential-audit-1234",
    wolters: "wolters-local-credential-audit-5678",
  } as const;

  try {
    const withheldEndpoint = process.env.VERA_WOLTERS_API_ENDPOINT;
    delete process.env.VERA_WOLTERS_API_ENDPOINT;
    const missingDeployment = await request(
      base,
      "PUT",
      "/aletheia/providers/wolters/secret",
      { secret: secrets.wolters },
    );
    assert.equal(missingDeployment.status, 428);
    assert.equal(
      (missingDeployment.body as { code: string }).code,
      "PRECONDITION_REQUIRED",
    );
    process.env.VERA_WOLTERS_API_ENDPOINT = withheldEndpoint;

    for (const [provider, secret] of Object.entries(secrets)) {
      const saved = await request(
        base,
        "PUT",
        `/aletheia/providers/${provider}/secret`,
        { secret },
      );
      assert.equal(saved.status, 200);
      const serialized = JSON.stringify(saved.body);
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes("audit-ciphertext"), false);
      repository.recordProviderTest(userId, provider as keyof typeof secrets, {
        status: "failed",
        error: secret,
      });
    }

    const listed = await request(base, "GET", "/aletheia/providers");
    assert.equal(listed.status, 200);
    const listJson = JSON.stringify(listed.body);
    for (const secret of Object.values(secrets)) {
      assert.equal(listJson.includes(secret), false);
    }
    const providers = (
      listed.body as { providers: Array<Record<string, unknown>> }
    ).providers;
    for (const provider of Object.keys(secrets)) {
      const status = providers.find((item) => item.provider === provider);
      assert(status);
      assert.equal(status.configured, true);
      assert.equal(status.hasSecret, true);
      assert.equal(status.encryptionEnabled, true);
      assert.equal(status.endpointConfigured, true);
      assert.equal(status.allowlisted, true);
      assert.equal(status.credentialReferenceConfigured, true);
      assert.equal(status.masked, "••••");
      assert.equal(status.readable, false);
      assert.equal(status.source, "encrypted_local");
      assert.equal(status.lastError, "Provider credential test failed.");

      const individual = await request(
        base,
        "GET",
        `/aletheia/providers/${provider}/status`,
      );
      assert.equal(individual.status, 200);
      const individualStatus = individual.body as Record<string, unknown>;
      assert.equal(individualStatus.hasSecret, true);
      assert.equal(individualStatus.encryptionEnabled, true);
      assert.equal(individualStatus.endpointConfigured, true);
      assert.equal(individualStatus.allowlisted, true);
      assert.equal(individualStatus.credentialReferenceConfigured, true);
      assert.equal(
        JSON.stringify(individual.body).includes(
          secrets[provider as keyof typeof secrets],
        ),
        false,
      );
    }

    for (const [provider, secret] of Object.entries(secrets)) {
      assert.equal(
        readLocalLegalSourceCredential(repository, userId, provider),
        secret,
      );
    }
    assertLocalControlError(
      () => readLocalLegalSourceCredential(repository, userId, "unsupported"),
      "INVALID_INPUT",
    );

    cipher.failFor(userId, "pkulaw");
    assertLocalControlError(
      () => readLocalLegalSourceCredential(repository, userId, "pkulaw"),
      "SECRET_STORAGE_UNAVAILABLE",
    );

    const remoteProvider = await request(
      base,
      "PUT",
      "/aletheia/providers/gemini/secret",
      { secret: "still-disabled-provider-secret" },
    );
    assert.equal(remoteProvider.status, 422);
    assert.equal(
      (remoteProvider.body as { code: string }).code,
      "UNSUPPORTED_SETTING",
    );

    for (const provider of Object.keys(secrets)) {
      const removed = await request(
        base,
        "DELETE",
        `/aletheia/providers/${provider}/secret`,
      );
      assert.equal(removed.status, 204);
      assertLocalControlError(
        () => readLocalLegalSourceCredential(repository, userId, provider),
        "NOT_FOUND",
      );
    }

    const afterRemoval = await request(base, "GET", "/aletheia/providers");
    const afterRemovalJson = JSON.stringify(afterRemoval.body);
    for (const secret of Object.values(secrets)) {
      assert.equal(afterRemovalJson.includes(secret), false);
    }

    console.log(
      JSON.stringify({
        ok: true,
        suite: "aletheia-legal-source-control-audit-v1",
        checks: ["save", "list-mask", "decrypt", "failure-codes", "remove"],
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main();
