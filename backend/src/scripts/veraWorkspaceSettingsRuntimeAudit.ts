import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { Express } from "express";

import { WorkspaceRuntime } from "../lib/workspace/runtime";
import { WorkspaceInferencePolicy } from "../lib/workspace/inferencePolicy";
import {
  CREDENTIAL_STORE_OPERATION_MODE,
  CredentialStoreCollisionError,
  type CredentialBindingKey,
  type CredentialDeletionInput,
  type CredentialResolutionInput,
  type CredentialStorageInput,
  type SynchronousCredentialStorePort,
} from "../lib/workspace/services/credentialStore";
import { CredentialWorkerCredentialNotFoundError } from "../lib/workspace/services/credentialWorkerClient";
import { createVeraApplication } from "../veraApplication";

const TOKEN = "vera-settings-runtime-audit-token-00000000000000000000";

class AuditCredentialStore implements SynchronousCredentialStorePort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE] = "synchronous" as const;
  private readonly values = new Map<
    string,
    { secret: string; binding: CredentialBindingKey }
  >();
  available = true;

  isAvailable() {
    return this.available;
  }

  removeAllOutsideVera() {
    this.values.clear();
  }

  store(input: CredentialStorageInput) {
    if (!this.available) throw new Error("credential store unavailable");
    if (this.values.has(input.reference)) {
      throw new CredentialStoreCollisionError();
    }
    this.values.set(input.reference, {
      secret: input.secret,
      binding: { ...input.binding },
    });
  }

  resolve(input: CredentialResolutionInput) {
    if (!this.available) throw new Error("credential store unavailable");
    const stored = this.values.get(input.reference);
    if (
      !stored ||
      stored.binding.profileId !== input.binding.profileId ||
      stored.binding.provider !== input.binding.provider ||
      stored.binding.canonicalOrigin !== input.binding.canonicalOrigin
    ) {
      throw new CredentialWorkerCredentialNotFoundError();
    }
    return stored.secret;
  }

  delete(input: CredentialDeletionInput) {
    if (!this.available) throw new Error("credential store unavailable");
    const stored = this.values.get(input.reference);
    if (
      stored &&
      (stored.binding.profileId !== input.binding.profileId ||
        stored.binding.provider !== input.binding.provider ||
        stored.binding.canonicalOrigin !== input.binding.canonicalOrigin)
    ) {
      throw new Error("credential binding mismatch");
    }
    this.values.delete(input.reference);
  }
}

type FetchGate = { wait: Promise<void>; release(): void };

function createGate(): FetchGate {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function authSecret(init?: RequestInit) {
  return (
    new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ??
    ""
  );
}

function modelFromUrl(value: string | URL | Request) {
  const url = new URL(
    typeof value === "string"
      ? value
      : value instanceof URL
        ? value.toString()
        : value.url,
  );
  const marker = "/models/";
  const index = url.pathname.lastIndexOf(marker);
  return index < 0
    ? null
    : decodeURIComponent(url.pathname.slice(index + marker.length));
}

async function withServer<T>(
  app: Express,
  operation: (baseUrl: string) => Promise<T>,
) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not bind");
  try {
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function environment(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    ALETHEIA_AUTH_MODE: "private_token",
    ALETHEIA_PRIVATE_AUTH_TOKEN: TOKEN,
    FRONTEND_URL: "http://localhost:3000",
    RATE_LIMIT_GENERAL_MAX: "1000",
    ...overrides,
  };
}

function headers(token = TOKEN) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function json(response: Response) {
  const text = await response.text();
  return {
    text,
    value: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function assertSecretFree(text: string, secrets: readonly string[]) {
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.equal(/credential_(?:ref|reference)/i.test(text), false);
  assert.equal(/keychain:\/\/vera\/model-profile\//i.test(text), false);
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "vera-settings-runtime-audit-"),
  );
  const originalEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const credentialStore = new AuditCredentialStore();
  let gate: FetchGate | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (gate) await gate.wait;
    const secret = authSecret(init);
    if (secret !== "valid-audit-secret") {
      return new Response("", { status: 401 });
    }
    const model = modelFromUrl(input);
    const requestUrl = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    return new Response(
      JSON.stringify(
        requestUrl.pathname.endsWith("/models")
          ? { data: [{ id: "generic-audit" }] }
          : { id: model },
      ),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const runtime = new WorkspaceRuntime({
    dataDir: root,
    blobs: { listStagedDeletesSync: () => [] } as never,
    credentialStore,
    modelProviderOptions: {
      fetchImpl,
      hardenedGenericTransport: {
        attestation: "dns-pinned-and-revalidated-v1",
        fetchImpl,
      },
    },
  });
  const app = createVeraApplication({
    runtime,
    env: environment({ RATE_LIMIT_MODEL_PROBE_MAX: "100" }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    auditWriteBlocked: () => false,
  });
  const databasePath = path.join(root, "aletheia.db");

  try {
    await runtime.start();
    assert.equal(runtime.health().started, true);

    await withServer(app, async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/api/v1/settings/status`, {
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      assert.equal(unauthenticated.status, 401);
      const wrongToken = await fetch(`${baseUrl}/api/v1/settings/status`, {
        headers: headers(`${TOKEN}-wrong`),
      });
      assert.equal(wrongToken.status, 401);

      const statusResponse = await fetch(`${baseUrl}/api/v1/settings/status`, {
        headers: headers(),
      });
      assert.equal(statusResponse.status, 200);
      const status = await json(statusResponse);
      assertSecretFree(status.text, []);
      const capabilities = status.value.capabilities as Record<string, unknown>;
      assert.equal(capabilities.settings_available, true);
      assert.equal(capabilities.runtime_wired, true);
      assert.equal(capabilities.credential_write_enabled, true);
      assert.equal(capabilities.secret_readback_supported, false);
      assert.deepEqual(capabilities.supported_providers, [
        "openai",
        "deepseek",
        "anthropic",
        "gemini",
        "openai_compatible",
      ]);

      const legacyModels = await fetch(`${baseUrl}/api/v1/models`, {
        headers: headers(),
      });
      assert.equal(legacyModels.status, 404);
      const enabledAtCreate = await fetch(`${baseUrl}/api/v1/model-profiles`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: "Unsafe model",
          provider: "openai",
          model: "gpt-audit",
          enabled: true,
        }),
      });
      assert.equal(enabledAtCreate.status, 400);
      const generic = await fetch(`${baseUrl}/api/v1/model-profiles`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: "Generic with pinned transport",
          provider: "openai_compatible",
          model: "generic-audit",
          base_url: "https://models.example.test/v1",
          capabilities: {
            streaming: true,
            toolCalling: false,
            structuredOutput: true,
            vision: false,
          },
        }),
      });
      assert.equal(generic.status, 201);
      const genericBody = await json(generic);
      assert.equal(genericBody.value.provider, "openai_compatible");
      assert.equal(genericBody.value.enabled, false);
      assert.deepEqual(genericBody.value.capabilities, {
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      });
      const genericId = String(genericBody.value.id);
      const missingPrivacy = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/privacy`,
        { headers: headers() },
      );
      assert.equal(missingPrivacy.status, 404);
      assert.equal(
        Number(
          runtime.database
            .prepare(
              "SELECT count(*) AS count FROM model_profile_privacy WHERE model_profile_id=?",
            )
            .get(genericId)?.count,
        ),
        0,
        "GET must not infer or persist model privacy metadata",
      );
      const incompletePrivacy = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/privacy`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ execution_location: "local" }),
        },
      );
      assert.equal(incompletePrivacy.status, 412);
      const unknownPrivacyField = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/privacy`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({
            execution_location: "confidential_remote",
            retention: "unknown",
            training_use: "unknown",
            sensitive_data_allowed: true,
            inferred_from_localhost: true,
          }),
        },
      );
      assert.equal(unknownPrivacyField.status, 400);
      const declaredPrivacy = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/privacy`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({
            execution_location: "confidential_remote",
            retention: "unknown",
            training_use: "unknown",
            sensitive_data_allowed: true,
          }),
        },
      );
      assert.equal(declaredPrivacy.status, 200);
      const declaredPrivacyBody = await json(declaredPrivacy);
      assertSecretFree(declaredPrivacyBody.text, []);
      assert.equal(
        declaredPrivacyBody.value.declaration_basis,
        "user_or_admin_declared",
      );
      assert.equal(declaredPrivacyBody.value.model_profile_enabled, false);
      await fetch(`${baseUrl}/api/v1/model-profiles/${genericId}/credential`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ secret: "valid-audit-secret" }),
      });
      const genericTested = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/test`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      assert.equal(genericTested.status, 200);
      assert.equal(
        (
          (await json(genericTested)).value.connection_test as Record<
            string,
            unknown
          >
        ).status,
        "passed",
      );
      const genericEnabled = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/enable`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      const genericEnabledBody = await json(genericEnabled);
      assert.equal(genericEnabledBody.value.enabled, true);
      const policy = new WorkspaceInferencePolicy(runtime.database);
      assert.deepEqual(
        policy.evaluate({
          scope: {
            scope: "global",
            projectId: null,
            matterProfilePresent: false,
          },
          modelProfileId: genericId,
          operation: "assistant",
        }),
        { decision: "deny", reasonCode: "model_retention_unknown" },
      );
      const confirmedPrivacy = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/privacy`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({
            retention: "zero",
            training_use: "prohibited",
          }),
        },
      );
      assert.equal(confirmedPrivacy.status, 200);
      const confirmedPrivacyBody = await json(confirmedPrivacy);
      assert(
        Date.parse(String(confirmedPrivacyBody.value.updated_at)) >
          Date.parse(String(declaredPrivacyBody.value.updated_at)),
        "privacy PATCH timestamps must move strictly forwards",
      );
      const projectId = "40000000-0000-4000-8000-000000000001";
      const matterId = "40000000-0000-4000-8000-000000000002";
      const at = new Date().toISOString();
      runtime.database
        .prepare(
          `INSERT INTO projects (id,name,status,created_at,updated_at)
           VALUES (?,'Privacy Project','active',?,?),
                  (?,'Privacy Matter','active',?,?)`,
        )
        .run(projectId, at, at, matterId, at, at);
      runtime.database
        .prepare(
          `INSERT INTO matter_profiles
             (project_id,matter_type,workspace_type,created_at,updated_at)
           VALUES (?,'general','general_legal',?,?)`,
        )
        .run(matterId, at, at);
      runtime.database
        .prepare(
          `INSERT INTO matter_policies
             (project_id,external_egress_mode,created_at,updated_at)
           VALUES (?,'allowed_by_policy',?,?)`,
        )
        .run(matterId, at, at);
      runtime.database
        .prepare(
          `INSERT INTO matter_policy_execution_locations
             (project_id,execution_location,created_at)
           VALUES (?,'confidential_remote',?)`,
        )
        .run(matterId, at);
      for (const projectIdValue of [null, projectId, matterId] as const) {
        assert.equal(
          policy.evaluate({
            scope: policy.resolveScope(projectIdValue),
            modelProfileId: genericId,
            operation:
              projectIdValue === matterId ? "tabular_generation" : "assistant",
          }).decision,
          "allow",
        );
      }
      const genericRevision = Number(
        (genericEnabledBody.value.endpoint_binding as Record<string, unknown>)
          .connection_revision,
      );
      const genericCapabilitiesChanged = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({
            capabilities: {
              streaming: true,
              toolCalling: true,
              structuredOutput: false,
              vision: false,
            },
          }),
        },
      );
      assert.equal(genericCapabilitiesChanged.status, 200);
      const genericChangedBody = await json(genericCapabilitiesChanged);
      assert.equal(genericChangedBody.value.enabled, false);
      assert.equal(
        (genericChangedBody.value.connection_test as Record<string, unknown>)
          .status,
        "stale",
      );
      assert.equal(
        Number(
          (genericChangedBody.value.endpoint_binding as Record<string, unknown>)
            .connection_revision,
        ),
        genericRevision + 1,
      );
      const genericEnableWithoutRetest = await fetch(
        `${baseUrl}/api/v1/model-profiles/${genericId}/enable`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      assert.equal(genericEnableWithoutRetest.status, 409);

      const unsupportedOfficialCapabilities = await fetch(
        `${baseUrl}/api/v1/model-profiles`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            name: "Invalid official override",
            provider: "openai",
            model: "gpt-audit",
            capabilities: {
              streaming: false,
              toolCalling: true,
              structuredOutput: true,
              vision: false,
            },
          }),
        },
      );
      assert.equal(unsupportedOfficialCapabilities.status, 400);

      const create = await fetch(`${baseUrl}/api/v1/model-profiles`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: "OpenAI audit",
          provider: "openai",
          model: "gpt-audit",
        }),
      });
      assert.equal(create.status, 201);
      const created = await json(create);
      assertSecretFree(created.text, []);
      const id = String(created.value.id);
      assert.match(id, /^[0-9a-f-]{36}$/i);
      assert.equal(created.value.enabled, false);
      assert.equal(
        (created.value.connection_test as Record<string, unknown>).status,
        "untested",
      );
      const revision0 = Number(
        (created.value.endpoint_binding as Record<string, unknown>)
          .connection_revision,
      );

      const secret = "valid-audit-secret";
      const credential = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/credential`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ secret }),
        },
      );
      assert.equal(credential.status, 200);
      const credentialBody = await json(credential);
      assertSecretFree(credentialBody.text, [secret]);
      assert.equal(
        (credentialBody.value.credential as Record<string, unknown>).status,
        "configured",
      );
      const revision1 = Number(
        (credentialBody.value.endpoint_binding as Record<string, unknown>)
          .connection_revision,
      );
      assert.equal(revision1, revision0 + 1);

      const tested = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/test`,
        {
          method: "POST",
          headers: headers(),
          body: "{}",
        },
      );
      assert.equal(tested.status, 200);
      const testedBody = await json(tested);
      assertSecretFree(testedBody.text, [secret]);
      assert.equal(
        (testedBody.value.connection_test as Record<string, unknown>).status,
        "passed",
      );
      assert.equal(testedBody.value.enabled, false);

      const enabled = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/enable`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      assert.equal(enabled.status, 200);
      const enabledBody = await json(enabled);
      assert.equal(enabledBody.value.enabled, true);
      assert.equal(
        (enabledBody.value.availability as Record<string, unknown>).status,
        "ready",
      );

      const selected = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/default`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      assert.equal(selected.status, 200);
      assert.equal((await json(selected)).value.is_default, true);

      gate = createGate();
      const pendingTest = fetch(`${baseUrl}/api/v1/model-profiles/${id}/test`, {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rebound = await fetch(`${baseUrl}/api/v1/model-profiles/${id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ model: "gpt-audit-next" }),
      });
      assert.equal(rebound.status, 200);
      const reboundBody = await json(rebound);
      assert.equal(reboundBody.value.enabled, false);
      assert.equal(reboundBody.value.is_default, false);
      gate.release();
      gate = null;
      const staleProbe = await pendingTest;
      assert.equal(staleProbe.status, 200);
      const staleBody = await json(staleProbe);
      assert.equal(staleBody.value.model, "gpt-audit-next");
      assert.equal(
        (staleBody.value.connection_test as Record<string, unknown>).status,
        "stale",
      );

      const badSecret = "bad-audit-secret";
      const replaced = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/credential`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ secret: badSecret }),
        },
      );
      assert.equal(replaced.status, 200);
      const authenticationFailure = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/test`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      assert.equal(authenticationFailure.status, 200);
      const failure = await json(authenticationFailure);
      assertSecretFree(failure.text, [secret, badSecret]);
      assert.equal(
        (failure.value.credential as Record<string, unknown>).status,
        "invalid",
      );
      assert.equal(
        (failure.value.connection_test as Record<string, unknown>).status,
        "failed",
      );
      assert.equal(
        (failure.value.connection_test as Record<string, unknown>).error_code,
        "authentication_failed",
      );

      const restored = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/credential`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ secret }),
        },
      );
      assert.equal(restored.status, 200);
      credentialStore.removeAllOutsideVera();
      const missingCredential = await fetch(
        `${baseUrl}/api/v1/model-profiles/${id}/test`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      assert.equal(missingCredential.status, 200);
      const missing = await json(missingCredential);
      assertSecretFree(missing.text, [secret, badSecret]);
      assert.equal(
        (missing.value.credential as Record<string, unknown>).status,
        "invalid",
      );
      assert.equal(
        (missing.value.connection_test as Record<string, unknown>).error_code,
        "credential_unavailable",
      );

      const settingsPatch = await fetch(`${baseUrl}/api/v1/settings`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ theme: "dark" }),
      });
      assert.equal(settingsPatch.status, 200);
      assert.equal((await json(settingsPatch)).value.theme, "dark");
    });

    const limitedApp = createVeraApplication({
      runtime,
      env: environment({ RATE_LIMIT_MODEL_PROBE_MAX: "2" }),
      auditAnchorStatus: () => ({ enabled: false, healthy: true }),
      auditWriteBlocked: () => false,
    });
    await withServer(limitedApp, async (baseUrl) => {
      const create = await fetch(`${baseUrl}/api/v1/model-profiles`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: "Rate limited probe",
          provider: "openai",
          model: "gpt-rate-limit",
        }),
      });
      const profile = await json(create);
      const id = String(profile.value.id);
      await fetch(`${baseUrl}/api/v1/model-profiles/${id}/credential`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ secret: "valid-audit-secret" }),
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(
          `${baseUrl}/api/v1/model-profiles/${id}/test`,
          {
            method: "POST",
            headers: {
              ...headers(),
              "x-forwarded-for": `203.0.113.${attempt + 1}`,
            },
            body: "{}",
          },
        );
        assert.equal(response.status, attempt < 2 ? 200 : 429);
      }
    });

    const blockedApp = createVeraApplication({
      runtime,
      env: environment({ RATE_LIMIT_MODEL_PROBE_MAX: "1" }),
      auditAnchorStatus: () => ({ enabled: true, healthy: false }),
      auditWriteBlocked: () => true,
    });
    await withServer(blockedApp, async (baseUrl) => {
      const target = `${baseUrl}/api/v1/model-profiles/00000000-0000-4000-8000-000000000001/test`;
      const unauthenticated = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(unauthenticated.status, 401);
      const blocked = await fetch(target, {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      assert.equal(blocked.status, 503);
    });

    credentialStore.available = false;
    const unavailableApp = createVeraApplication({
      runtime,
      env: environment(),
      auditAnchorStatus: () => ({ enabled: false, healthy: true }),
      auditWriteBlocked: () => false,
    });
    await withServer(unavailableApp, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/settings/status`, {
        headers: headers(),
      });
      const body = await json(response);
      const capabilities = body.value.capabilities as Record<string, unknown>;
      assert.equal(capabilities.settings_available, false);
      assert.equal(capabilities.runtime_wired, false);
      assert.equal(capabilities.credential_write_enabled, false);
      const defaultSelection = await fetch(`${baseUrl}/api/v1/settings`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          default_model_profile_id: "00000000-0000-4000-8000-000000000001",
        }),
      });
      assert.equal(defaultSelection.status, 409);
    });

    const applicationSource = readFileSync(
      path.resolve("src/veraApplication.ts"),
      "utf8",
    );
    const authIndex = applicationSource.indexOf(
      "workspaceApi.use(createWorkspaceAuthMiddleware(env))",
    );
    const guardIndex = applicationSource.indexOf(
      "workspaceApi.use(mutationGuard)",
    );
    const probeIndex = applicationSource.indexOf(
      'workspaceApi.use("/model-profiles/:id/test", modelProbeLimiter)',
    );
    const settingsIndex = applicationSource.indexOf(
      "createWorkspaceSettingsV1Router",
      probeIndex,
    );
    assert.ok(authIndex > 0 && authIndex < guardIndex);
    assert.ok(guardIndex < probeIndex && probeIndex < settingsIndex);
    const runtimeSource = readFileSync(
      path.resolve("src/lib/workspace/runtime.ts"),
      "utf8",
    );
    assert.ok(
      runtimeSource.indexOf("this.startMigrations()") <
        runtimeSource.indexOf(
          "await this.modelSettings.reconcileCredentialOrphans()",
        ),
    );
  } finally {
    try {
      await runtime.stop();
    } finally {
      if (originalEncryption === undefined) {
        delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
      } else {
        process.env.ALETHEIA_DATABASE_ENCRYPTION = originalEncryption;
      }
    }
    if (readFileSync(databasePath).includes(Buffer.from("audit-secret"))) {
      throw new Error("workspace database persisted a credential secret");
    }
    rmSync(root, { recursive: true, force: true });
  }
  console.log("veraWorkspaceSettingsRuntimeAudit: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
