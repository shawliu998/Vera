import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  private encryptionAvailable = true;
  private sequence = 0;

  encrypt(plaintext: string, context: string) {
    if (!this.encryptionAvailable) {
      throw new Error(`cipher unavailable ${plaintext}`);
    }
    const envelope = `audit-ciphertext-${++this.sequence}`;
    this.records.set(envelope, { plaintext, context });
    return envelope;
  }

  decrypt(envelope: string, context: string) {
    const record = this.records.get(envelope);
    if (this.failContexts.has(context)) {
      throw new Error(
        `audit cipher unavailable for ${record?.plaintext ?? "unknown"}`,
      );
    }
    if (!record || record.context !== context)
      throw new Error("audit cipher mismatch");
    return record.plaintext;
  }

  failFor(userId: string, provider: string) {
    this.failContexts.add(`provider-secret:${userId}:${provider}`);
  }

  setEncryptionAvailable(available: boolean) {
    this.encryptionAvailable = available;
  }
}

const AUTH_TOKEN = "legal-source-route-audit-token";

async function request(
  base: string,
  method: string,
  url: string,
  body?: unknown,
  authenticated = true,
) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

const PROVIDER_STATUS_KEYS = [
  "allowlisted",
  "capabilities",
  "connectionStatus",
  "contractVersion",
  "credentialReferenceConfigured",
  "dataUsePolicy",
  "deploymentReady",
  "encryptionEnabled",
  "endpointConfigured",
  "hasSecret",
  "integration",
  "provider",
] as const;

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertStrictStatus(value: unknown) {
  const status = object(value);
  assert.deepEqual(
    Object.keys(status).sort(),
    [...PROVIDER_STATUS_KEYS].sort(),
  );
  assert(
    status.provider === "pkulaw" ||
      status.provider === "yuandian" ||
      status.provider === "wolters",
  );
  assert.equal(typeof status.deploymentReady, "boolean");
  assert.equal(typeof status.endpointConfigured, "boolean");
  assert.equal(typeof status.allowlisted, "boolean");
  assert.equal(typeof status.credentialReferenceConfigured, "boolean");
  assert.equal(typeof status.hasSecret, "boolean");
  assert.equal(typeof status.encryptionEnabled, "boolean");
  assert.equal(status.contractVersion, "vera-legal-research-provider-v2");
  assert.equal(status.integration, "authorized_provider_adapter");
  assert.deepEqual(status.capabilities, {
    search: true,
    fetchFullText: status.provider !== "pkulaw",
    pagination: false,
    getByCitation: false,
    jurisdictionFilter: false,
    asOfDateFilter: false,
    structuredFilters: false,
    dynamicToolInvocation: false,
    requiresExplicitEgressApproval: true,
    documentKinds:
      status.provider === "pkulaw"
        ? ["statute", "judicial_interpretation", "other"]
        : ["statute", "judicial_interpretation", "case", "other"],
  });
  assert.deepEqual(status.dataUsePolicy, {
    basis: "not_declared",
    retention: "not_declared",
    export: "not_declared",
    modelUse: "not_declared",
  });
  const connection = object(status.connectionStatus);
  assert.deepEqual(Object.keys(connection).sort(), [
    "connectionTested",
    "reason",
    "state",
  ]);
  assert(
    connection.state === "unavailable" ||
      connection.state === "configured_unverified",
  );
  assert.equal(connection.connectionTested, false);
  return status;
}

function assertProviderListResponse(value: unknown) {
  const response = object(value);
  assert.deepEqual(Object.keys(response).sort(), [
    "detail",
    "localOnly",
    "providers",
    "schemaVersion",
  ]);
  assert.equal(response.schemaVersion, "vera-legal-source-provider-status-v2");
  assert.equal(response.localOnly, true);
  assert.equal(typeof response.detail, "string");
  assert(Array.isArray(response.providers));
  assert.equal(response.providers.length, 3);
  return response.providers.map(assertStrictStatus);
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
  const localControlSource = readFileSync(
    path.resolve(process.cwd(), "src/routes/aletheiaLocalControl.ts"),
    "utf8",
  );
  assert.match(
    localControlSource,
    /LEGAL_SOURCE_RETENTION_ACTIVATION_V13\.open &&\s+dataUsePolicyReady &&\s+item\.configured/u,
    "a future-open retention gate must still block credential decryption until a deployment policy is declared",
  );
  assert.match(
    localControlSource,
    /projectLegalResearchProviderConnectionStatus\(\{[\s\S]*?dataUsePolicyReady,[\s\S]*?\}\)/u,
    "local status must project the same data-use-policy gate as provider execution",
  );

  const directory = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-legal-source-control-audit-"),
  );
  process.env.ALETHEIA_DATA_DIR = directory;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 91).toString(
    "base64",
  );
  process.env.VERA_PKULAW_API_ENDPOINT =
    "https://apim-gw.pkulaw.com/vera_law_semantic_01/mcp";
  process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "apim-gw.pkulaw.com";
  process.env.VERA_PKULAW_API_CREDENTIAL_REF = "pkulaw-local-credential";
  process.env.VERA_YUANDIAN_API_ENDPOINT = "https://open.chineselaw.com";
  process.env.VERA_YUANDIAN_API_ALLOWED_HOSTS = "open.chineselaw.com";
  process.env.VERA_YUANDIAN_API_CREDENTIAL_REF = "yuandian-local-credential";
  process.env.VERA_WOLTERS_API_ENDPOINT =
    "https://api.wolters.example/research";
  process.env.VERA_WOLTERS_API_ALLOWED_HOSTS = "api.wolters.example";
  process.env.VERA_WOLTERS_API_CREDENTIAL_REF = "wolters-local-credential";

  const userId = "legal-source-control-audit-user";
  const cipher = new AuditCipher();
  const repository = new LocalControlRepository({
    databasePath: path.join(directory, "aletheia.db"),
    cipher,
  });
  let providerSecretReads = 0;
  const originalProviderSecretForUse =
    repository.providerSecretForUse.bind(repository);
  Object.defineProperty(repository, "providerSecretForUse", {
    configurable: true,
    value: (
      ...args: Parameters<LocalControlRepository["providerSecretForUse"]>
    ) => {
      providerSecretReads += 1;
      return originalProviderSecretForUse(...args);
    },
  });
  const originalListProviderStatuses =
    repository.listProviderStatuses.bind(repository);
  Object.defineProperty(repository, "listProviderStatuses", {
    configurable: true,
    value: (requestedUserId: string) =>
      originalListProviderStatuses(requestedUserId).map((item) => ({
        ...item,
        endpoint: "https://must-not-cross-wire.invalid/private",
        credentialReference: "must-not-cross-wire-reference",
        encryptedSecret: "must-not-cross-wire-ciphertext",
        internalOnly: "must-not-cross-wire-internal-field",
      })),
  });
  const auth: RequestHandler = (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      return void res.status(401).json({
        code: "UNAUTHORIZED",
        detail: "Authentication is required.",
      });
    }
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
    yuandian: "yuandian-local-credential-audit-9012",
    wolters: "wolters-local-credential-audit-5678",
  } as const;

  try {
    const unauthenticated = await request(
      base,
      "GET",
      "/aletheia/providers",
      undefined,
      false,
    );
    assert.equal(unauthenticated.status, 401);

    const withheldEndpoint = process.env.VERA_WOLTERS_API_ENDPOINT;
    delete process.env.VERA_WOLTERS_API_ENDPOINT;
    const missingDeploymentList = await request(
      base,
      "GET",
      "/aletheia/providers",
    );
    const missingEndpointStatus = assertProviderListResponse(
      missingDeploymentList.body,
    ).find((status) => status.provider === "wolters");
    assert(missingEndpointStatus);
    assert.equal(missingEndpointStatus.deploymentReady, false);
    assert.deepEqual(missingEndpointStatus.connectionStatus, {
      state: "unavailable",
      reason: "endpoint_missing",
      connectionTested: false,
    });
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
    assert.equal(
      JSON.stringify(missingDeployment.body).includes(secrets.wolters),
      false,
    );
    process.env.VERA_WOLTERS_API_ENDPOINT = withheldEndpoint!;

    process.env.VERA_WOLTERS_API_ENDPOINT =
      "https://not-allowlisted.example/research";
    const notAllowlisted = assertProviderListResponse(
      (await request(base, "GET", "/aletheia/providers")).body,
    ).find((status) => status.provider === "wolters");
    assert(notAllowlisted);
    assert.deepEqual(notAllowlisted.connectionStatus, {
      state: "unavailable",
      reason: "endpoint_not_allowlisted",
      connectionTested: false,
    });
    process.env.VERA_WOLTERS_API_ENDPOINT = withheldEndpoint!;

    const withheldCredentialReference =
      process.env.VERA_WOLTERS_API_CREDENTIAL_REF;
    delete process.env.VERA_WOLTERS_API_CREDENTIAL_REF;
    const missingReference = assertProviderListResponse(
      (await request(base, "GET", "/aletheia/providers")).body,
    ).find((status) => status.provider === "wolters");
    assert(missingReference);
    assert.deepEqual(missingReference.connectionStatus, {
      state: "unavailable",
      reason: "credential_reference_missing",
      connectionTested: false,
    });
    process.env.VERA_WOLTERS_API_CREDENTIAL_REF = withheldCredentialReference!;

    const beforeSave = assertProviderListResponse(
      (await request(base, "GET", "/aletheia/providers")).body,
    );
    for (const status of beforeSave) {
      assert.equal(status.deploymentReady, true);
      assert.equal(status.hasSecret, false);
      assert.deepEqual(status.connectionStatus, {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });
    }

    const unauthorizedSecret = "unauthorized-secret-must-not-echo";
    const unauthorizedSave = await request(
      base,
      "PUT",
      "/aletheia/providers/pkulaw/secret",
      { secret: unauthorizedSecret },
      false,
    );
    assert.equal(unauthorizedSave.status, 401);
    assert.equal(
      JSON.stringify(unauthorizedSave.body).includes(unauthorizedSecret),
      false,
    );

    const unknownFieldSecret = "unknown-field-secret-must-not-echo";
    const unknownSecretField = await request(
      base,
      "PUT",
      "/aletheia/providers/pkulaw/secret",
      { secret: secrets.pkulaw, [unknownFieldSecret]: true },
    );
    assert.equal(unknownSecretField.status, 400);
    assert.equal(
      JSON.stringify(unknownSecretField.body).includes(unknownFieldSecret),
      false,
    );

    for (const [provider, secret] of Object.entries(secrets)) {
      const saved = await request(
        base,
        "PUT",
        `/aletheia/providers/${provider}/secret`,
        { secret },
      );
      assert.equal(saved.status, 200);
      const savedStatus = assertStrictStatus(saved.body);
      assert.equal(savedStatus.provider, provider);
      assert.equal(savedStatus.hasSecret, true);
      assert.equal(savedStatus.deploymentReady, true);
      assert.deepEqual(savedStatus.connectionStatus, {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });
      const serialized = JSON.stringify(saved.body);
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes("audit-ciphertext"), false);
    }

    repository.recordProviderTest(userId, "pkulaw", {
      status: "passed",
    });
    repository.recordProviderTest(userId, "yuandian", {
      status: "passed",
    });
    repository.recordProviderTest(userId, "wolters", {
      status: "unsupported",
      error: secrets.wolters,
    });

    const listed = await request(base, "GET", "/aletheia/providers");
    assert.equal(listed.status, 200);
    const listJson = JSON.stringify(listed.body);
    for (const secret of Object.values(secrets)) {
      assert.equal(listJson.includes(secret), false);
    }
    assert.equal(listJson.includes("apim-gw.pkulaw.com"), false);
    assert.equal(listJson.includes("open.chineselaw.com"), false);
    assert.equal(listJson.includes("api.wolters.example"), false);
    assert.equal(listJson.includes("pkulaw-local-credential"), false);
    assert.equal(listJson.includes("yuandian-local-credential"), false);
    assert.equal(listJson.includes("wolters-local-credential"), false);
    assert.equal(listJson.includes("must-not-cross-wire"), false);
    const providers = assertProviderListResponse(listed.body);
    for (const provider of Object.keys(secrets)) {
      const status = providers.find((item) => item.provider === provider);
      assert(status);
      assert.equal(status.hasSecret, true);
      assert.equal(status.encryptionEnabled, true);
      assert.equal(status.deploymentReady, true);
      assert.equal(status.endpointConfigured, true);
      assert.equal(status.allowlisted, true);
      assert.equal(status.credentialReferenceConfigured, true);
      assert.deepEqual(status.connectionStatus, {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });

      const individual = await request(
        base,
        "GET",
        `/aletheia/providers/${provider}/status`,
      );
      assert.equal(individual.status, 200);
      const individualStatus = assertStrictStatus(individual.body);
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
      assert.equal(
        JSON.stringify(individual.body).includes("must-not-cross-wire"),
        false,
      );
    }

    repository.recordProviderTest(userId, "pkulaw", {
      status: "failed",
      error: secrets.pkulaw,
    });
    const historicalFailure = assertStrictStatus(
      (await request(base, "GET", "/aletheia/providers/pkulaw/status")).body,
    );
    assert.deepEqual(historicalFailure.connectionStatus, {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    });

    const disabledTest = await request(
      base,
      "POST",
      "/aletheia/providers/pkulaw/test",
    );
    assert.equal(disabledTest.status, 422);
    assert.equal(
      (disabledTest.body as { code: string }).code,
      "UNSUPPORTED_SETTING",
    );

    cipher.setEncryptionAvailable(false);
    const storageUnavailable = assertProviderListResponse(
      (await request(base, "GET", "/aletheia/providers")).body,
    );
    for (const status of storageUnavailable) {
      assert.equal(status.encryptionEnabled, false);
      assert.deepEqual(status.connectionStatus, {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });
    }
    const storageFailureSecret = "storage-failure-secret-must-not-echo";
    const storageFailure = await request(
      base,
      "PUT",
      "/aletheia/providers/pkulaw/secret",
      { secret: storageFailureSecret },
    );
    assert.equal(storageFailure.status, 503);
    assert.equal(
      JSON.stringify(storageFailure.body).includes(storageFailureSecret),
      false,
    );
    cipher.setEncryptionAvailable(true);

    assert.equal(
      providerSecretReads,
      0,
      "the closed activation gate must not decrypt credentials for status or mutation projections",
    );

    for (const [provider, secret] of Object.entries(secrets)) {
      assert.equal(
        readLocalLegalSourceCredential(repository, userId, provider),
        secret,
      );
    }
    assert.equal(providerSecretReads, 3);
    assertLocalControlError(
      () => readLocalLegalSourceCredential(repository, userId, "unsupported"),
      "INVALID_INPUT",
    );
    assert.equal(providerSecretReads, 3);

    cipher.failFor(userId, "pkulaw");
    assertLocalControlError(
      () => readLocalLegalSourceCredential(repository, userId, "pkulaw"),
      "SECRET_STORAGE_UNAVAILABLE",
    );
    assert.equal(providerSecretReads, 4);
    const corruptedCredential = assertStrictStatus(
      (await request(base, "GET", "/aletheia/providers/pkulaw/status")).body,
    );
    assert.equal(
      providerSecretReads,
      4,
      "closed-gate status reads must not probe a corrupt credential",
    );
    assert.equal(corruptedCredential.hasSecret, true);
    assert.equal(corruptedCredential.encryptionEnabled, true);
    assert.deepEqual(corruptedCredential.connectionStatus, {
      state: "unavailable",
      reason: "activation_gate_closed",
      connectionTested: false,
    });
    assert.equal(
      JSON.stringify(corruptedCredential).includes(secrets.pkulaw),
      false,
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
    assert.equal(
      JSON.stringify(remoteProvider.body).includes(
        "still-disabled-provider-secret",
      ),
      false,
    );
    const remoteRemove = await request(
      base,
      "DELETE",
      "/aletheia/providers/gemini/secret",
    );
    assert.equal(remoteRemove.status, 422);

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
    for (const provider of assertProviderListResponse(afterRemoval.body)) {
      assert.deepEqual(provider.connectionStatus, {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });
    }

    const internalFailureMaterial =
      "/private/vera/provider.db internal-secret-must-not-cross-wire";
    Object.defineProperty(repository, "listProviderStatuses", {
      configurable: true,
      value: () => {
        throw new Error(internalFailureMaterial);
      },
    });
    const internalFailure = await request(base, "GET", "/aletheia/providers");
    assert.equal(internalFailure.status, 500);
    assert.deepEqual(internalFailure.body, {
      code: "LOCAL_CONTROL_ERROR",
      detail: "Local control operation failed.",
    });
    assert.equal(
      JSON.stringify(internalFailure.body).includes(internalFailureMaterial),
      false,
    );

    console.log(
      JSON.stringify({
        ok: true,
        suite: "aletheia-legal-source-control-audit-v2",
        checks: [
          "save",
          "strict-secret-free-wire",
          "provider-contract-projection",
          "truthful-code-owned-activation-gate-status",
          "closed-gate status projections perform zero credential decryptions",
          "future-open-gate-undeclared-policy-zero-credential-boundary",
          "historical-test-state-ignored",
          "unavailable-reason-precedence",
          "authentication-and-deployment-gates",
          "decrypt",
          "corrupt-ciphertext-fails-closed",
          "secret-safe-failure-codes",
          "unclassified-internal-errors-are-redacted",
          "remove",
        ],
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
