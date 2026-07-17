import assert from "node:assert/strict";
import http from "node:http";

import express, { type Express } from "express";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceLegalProvidersRepository } from "../lib/workspace/repositories/legalProviders";
import {
  type LegalProviderCredentialInput,
  type LegalProviderCredentialStorePort,
} from "../lib/workspace/services/legalProviderCredentialStore";
import { WorkspaceLegalProviderHubService } from "../lib/workspace/services/legalProviderHub";
import { WorkspaceLegalProviderHubV1Adapter } from "../lib/workspace/services/legalProviderHubV1Adapter";
import { createWorkspaceLegalProvidersV1Router } from "../routes/workspaceLegalProvidersV1";

const PROFILE_ID = "0195a5a0-7b1d-7000-8000-000000000201";
const ACTIVE_PROJECT_ID = "0195a5a0-7b1d-7000-8000-000000000202";
const ARCHIVED_PROJECT_ID = "0195a5a0-7b1d-7000-8000-000000000203";
const SECRET = "legal-provider-integration-audit-secret-never-return";
const NOW = "2026-07-16T08:00:00.000Z";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as JsonRecord;
}

class FakeCredentialStore implements LegalProviderCredentialStorePort {
  readonly values = new Map<string, string>();

  isAvailable() {
    return true;
  }

  async storeLegalProviderCredential(
    input: LegalProviderCredentialInput & { secret: string },
  ) {
    assert.equal(input.binding.profileId, PROFILE_ID);
    this.values.set(input.reference, input.secret);
  }

  async resolveLegalProviderCredential(input: LegalProviderCredentialInput) {
    const value = this.values.get(input.reference);
    assert.ok(value, "connection probe must resolve the stored credential");
    return value;
  }

  async deleteLegalProviderCredential(input: LegalProviderCredentialInput) {
    this.values.delete(input.reference);
  }
}

function assertSafeResponse(text: string) {
  assert.equal(text.includes(SECRET), false, "response leaked the credential");
  assert.equal(
    /keychain:\/\//i.test(text),
    false,
    "response leaked credential ref",
  );
  assert.equal(
    /credential_(?:reference|ref)|"(?:secret|token|authorization|url)"\s*:/i.test(
      text,
    ),
    false,
    "response exposed a sensitive field",
  );
  assert.equal(
    /https?:\/\//i.test(text),
    false,
    "response leaked endpoint URL",
  );
}

async function withServer<T>(
  app: Express,
  operation: (origin: string) => Promise<T>,
) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function requestJson(
  origin: string,
  route: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${origin}${route}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  assertSafeResponse(text);
  return {
    response,
    value: record(JSON.parse(text) as unknown, `${route} response`),
  };
}

async function main() {
  const database = new WorkspaceDatabase(":memory:");
  try {
    assert.equal(database.migration?.currentVersion, 23);
    const credentials = new FakeCredentialStore();
    let repositoryClockOffset = 0;
    const repository = new WorkspaceLegalProvidersRepository(database, () =>
      new Date(Date.parse(NOW) + repositoryClockOffset++).toISOString(),
    );
    let probeCount = 0;
    const service = new WorkspaceLegalProviderHubService(
      repository,
      credentials,
      {
        clock: () => new Date(NOW),
        monotonicNowMs: (() => {
          const values = [100, 112];
          return () => values.shift() ?? 112;
        })(),
        nextProfileId: () => PROFILE_ID,
        nextCredentialLocatorId: () => "a".repeat(64),
        createConnectionProbe: (input) => ({
          async verify(signal) {
            assert.equal(signal.aborted, false);
            assert.deepEqual(input.authorityCapabilities, ["case", "law"]);
            assert.equal(
              await input.resolveCredential(input.credentialReference, signal),
              SECRET,
            );
            probeCount += 1;
          },
        }),
      },
    );
    const projects = {
      get(projectId: string) {
        if (projectId === ACTIVE_PROJECT_ID) {
          return { id: projectId, status: "active" as const };
        }
        if (projectId === ARCHIVED_PROJECT_ID) {
          return { id: projectId, status: "archived" as const };
        }
        throw new Error("unexpected integration-audit project");
      },
    };
    const adapter = new WorkspaceLegalProviderHubV1Adapter(
      service,
      projects as never,
    );
    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use(
      createWorkspaceLegalProvidersV1Router({
        hub: adapter,
        context: () => ({ principalId: WORKSPACE_LOCAL_PRINCIPAL_ID }),
      }),
    );

    await withServer(app, async (origin) => {
      const created = await requestJson(origin, "/legal-providers/yuandian", {
        method: "POST",
        body: "{}",
      });
      assert.equal(created.response.status, 201);
      const initialProfile = record(created.value.profile, "created profile");
      assert.equal(initialProfile.revision, 0);
      assert.equal(initialProfile.status, "not_configured");
      assert.equal(initialProfile.credential_configured, false);

      const initialStatus = await requestJson(
        origin,
        `/projects/${ACTIVE_PROJECT_ID}/legal-research/status`,
      );
      assert.equal(initialStatus.response.status, 200);
      assert.equal(initialStatus.value.status, "not_configured");
      assert.equal(initialStatus.value.reason, "credential_missing");
      assert.equal(initialStatus.value.provider_id, PROFILE_ID);

      const credential = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/credential`,
        {
          method: "PUT",
          body: JSON.stringify({ expected_revision: 0, secret: SECRET }),
        },
      );
      assert.equal(
        credential.response.status,
        200,
        JSON.stringify(credential.value),
      );
      const configured = record(credential.value.profile, "configured profile");
      assert.equal(configured.revision, 1);
      assert.equal(configured.status, "configured_unverified");
      assert.equal(configured.credential_configured, true);

      const enableBeforeTest = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/enable`,
        {
          method: "POST",
          body: JSON.stringify({ expected_revision: 1 }),
        },
      );
      assert.equal(enableBeforeTest.response.status, 409);
      assert.equal(
        record(enableBeforeTest.value.error, "enable error").code,
        "PRECONDITION_FAILED",
      );

      const tested = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/test`,
        {
          method: "POST",
          body: JSON.stringify({ expected_revision: 1 }),
        },
      );
      assert.equal(tested.response.status, 200);
      const testedProfile = record(tested.value.profile, "tested profile");
      assert.equal(testedProfile.revision, 1);
      assert.equal(testedProfile.status, "activation_gate_closed");
      assert.equal(
        record(testedProfile.connection_test, "connection test").status,
        "passed",
      );
      assert.equal(probeCount, 1);

      const enabled = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/enable`,
        {
          method: "POST",
          body: JSON.stringify({ expected_revision: 1 }),
        },
      );
      assert.equal(enabled.response.status, 200);
      const enabledProfile = record(enabled.value.profile, "enabled profile");
      assert.equal(enabledProfile.revision, 2);
      assert.equal(enabledProfile.enabled, true);
      assert.equal(enabledProfile.status, "activation_gate_closed");

      const stale = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/enable`,
        {
          method: "POST",
          body: JSON.stringify({ expected_revision: 1 }),
        },
      );
      assert.equal(stale.response.status, 409);
      assert.equal(record(stale.value.error, "stale error").code, "CONFLICT");

      const deleted = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/credential`,
        {
          method: "DELETE",
          body: JSON.stringify({ expected_revision: 2 }),
        },
      );
      assert.equal(deleted.response.status, 200);
      const deletedProfile = record(deleted.value.profile, "deleted profile");
      assert.equal(deletedProfile.revision, 3);
      assert.equal(deletedProfile.enabled, false);
      assert.equal(deletedProfile.credential_configured, false);
      assert.equal(credentials.values.size, 0);

      const archived = await requestJson(
        origin,
        `/projects/${ARCHIVED_PROJECT_ID}/legal-research/status`,
      );
      assert.equal(archived.response.status, 200);
      assert.equal(archived.value.status, "unavailable");
      assert.equal(archived.value.reason, "project_not_eligible");
      assert.equal(archived.value.provider_id, null);
    });

    console.log(
      JSON.stringify({
        ok: true,
        suite: "vera-workspace-legal-provider-integration-audit-v1",
        migrationVersion: database.migration?.currentVersion,
        probeCount,
        networkUsed: false,
      }),
    );
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
