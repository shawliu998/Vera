import assert from "node:assert/strict";
import test from "node:test";

import { VeraApiError } from "../src/app/lib/veraApi.ts";
import {
  createVeraModelProfile,
  deleteVeraModelCredential,
  deleteVeraModelProfile,
  disableVeraModelProfile,
  enableVeraModelProfile,
  getVeraModelSettingsStatus,
  getVeraWorkspaceSettings,
  listVeraModelProfiles,
  parseVeraModelProfile,
  parseVeraModelSettingsStatus,
  patchVeraWorkspaceSettings,
  putVeraModelCredential,
  setDefaultVeraModelProfile,
  testVeraModelProfile,
  updateVeraModelProfile,
} from "../src/app/lib/veraModelSettingsApi.ts";
import {
  submitVeraCredentialInput,
  VeraCredentialInputError,
} from "../src/app/components/models/modelCredentialSubmission.ts";
import {
  installVeraTheme,
  VERA_SYSTEM_DARK_QUERY,
} from "../src/app/lib/veraTheme.ts";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";
const NOW = "2026-07-15T00:00:00.000Z";

function settings() {
  return {
    locale: "zh-CN",
    theme: "system",
    default_model_profile_id: null,
    default_project_id: null,
    updated_at: NOW,
  };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    name: "主要 OpenAI",
    provider: "openai",
    model: "gpt-5.5",
    base_url: null,
    context_window_tokens: null,
    max_output_tokens: null,
    enabled: false,
    is_default: false,
    created_at: NOW,
    updated_at: NOW,
    capabilities: {
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
    },
    credential: {
      status: "missing",
      configured: false,
      canonical_origin: "https://api.openai.com",
    },
    endpoint_binding: {
      provider: "openai",
      model: "gpt-5.5",
      normalized_base_url: "https://api.openai.com/v1",
      canonical_origin: "https://api.openai.com",
      execution_revision: 0,
      connection_revision: 0,
      profile_updated_at: NOW,
    },
    availability: {
      status: "disabled",
      selectable: false,
    },
    connection_test: {
      status: "untested",
      error_code: null,
      retryable: false,
      latency_ms: null,
      tested_at: null,
    },
    requires_credential: true,
    ...overrides,
  };
}

function status() {
  return {
    capabilities: {
      schema_version: "vera-workspace-model-settings-v1",
      settings_available: true,
      local_only: true,
      loopback_http_allowed: false,
      supported_providers: ["openai"],
      credential_write_enabled: true,
      secret_readback_supported: false,
      runtime_wired: true,
    },
    settings: settings(),
    models: [model()],
  };
}

test("model settings parser accepts only the strict secret-free canonical wire", () => {
  const parsed = parseVeraModelSettingsStatus(status());
  assert.equal(parsed.capabilities.settings_available, true);
  assert.equal(parsed.capabilities.secret_readback_supported, false);
  assert.deepEqual(parsed.capabilities.supported_providers, ["openai"]);
  assert.equal(parsed.models[0]?.connection_test.status, "untested");

  for (const sensitiveField of [
    "secret",
    "client_secret",
    "api_key",
    "providerApiKey",
    "credential_ref",
    "credentialRef",
    "credential_refs",
    "credential_reference",
    "credentialReferences",
    "providerApiKeys",
    "nestedSecrets",
  ]) {
    const poisoned = status();
    Object.assign(poisoned.models[0]!.credential, {
      [sensitiveField]: "must-not-cross-the-wire",
    });
    assert.throws(
      () => parseVeraModelSettingsStatus(poisoned),
      (error) =>
        error instanceof VeraApiError && error.code === "INVALID_RESPONSE",
      sensitiveField,
    );
  }

  assert.throws(
    () => parseVeraModelProfile({ ...model(), reference: "opaque" }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraModelProfile({
        ...model(),
        connection_test: {
          status: "passed",
          error_code: null,
          retryable: false,
          latency_ms: 24,
          tested_at: null,
        },
      }),
    VeraApiError,
  );
  const unavailable = parseVeraModelSettingsStatus({
    ...status(),
    capabilities: {
      ...status().capabilities,
      settings_available: false,
    },
  });
  assert.equal(unavailable.capabilities.settings_available, false);

  assert.throws(
    () =>
      parseVeraModelProfile({
        ...model(),
        connection_test: {
          status: "failed",
          error_code: "RAW_PROVIDER_ERROR",
          retryable: false,
          latency_ms: 24,
          tested_at: NOW,
        },
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraModelProfile({
        ...model(),
        endpoint_binding: {
          ...model().endpoint_binding,
          connection_revision: 2_147_483_648,
        },
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraModelProfile({
        ...model(),
        endpoint_binding: {
          ...model().endpoint_binding,
          normalized_base_url: "http://example.com/v1",
        },
      }),
    VeraApiError,
  );
  assert.equal(
    parseVeraModelProfile({
      ...model(),
      connection_test: {
        status: "failed",
        error_code: "timeout",
        retryable: true,
        latency_ms: 600_000,
        tested_at: NOW,
      },
    }).connection_test.latency_ms,
    600_000,
  );
  assert.throws(
    () =>
      parseVeraModelProfile({
        ...model(),
        connection_test: {
          status: "failed",
          error_code: "timeout",
          retryable: true,
          latency_ms: 600_001,
          tested_at: NOW,
        },
      }),
    VeraApiError,
  );
});

test("connection readiness accepts only the v9 discriminated lowercase states", () => {
  const passed = parseVeraModelProfile(
    model({
      enabled: true,
      credential: {
        status: "configured",
        configured: true,
        canonical_origin: "https://api.openai.com",
      },
      availability: { status: "ready", selectable: true },
      connection_test: {
        status: "passed",
        error_code: null,
        retryable: false,
        latency_ms: 42,
        tested_at: NOW,
      },
    }),
  );
  assert.equal(passed.connection_test.status, "passed");
  assert.equal(passed.connection_test.latency_ms, 42);

  const failed = parseVeraModelProfile(
    model({
      connection_test: {
        status: "failed",
        error_code: "authentication_failed",
        retryable: false,
        latency_ms: 12,
        tested_at: NOW,
      },
    }),
  );
  assert.equal(failed.connection_test.error_code, "authentication_failed");

  const stale = parseVeraModelProfile(
    model({
      connection_test: {
        status: "stale",
        error_code: null,
        retryable: false,
        latency_ms: 42,
        tested_at: NOW,
      },
    }),
  );
  assert.equal(stale.connection_test.status, "stale");

  assert.throws(
    () =>
      parseVeraModelProfile({
        ...model(),
        enabled: true,
        availability: { status: "ready", selectable: true },
      }),
    VeraApiError,
  );
});

test("canonical Settings and model-profile methods use only the declared routes", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
        },
        async getAuthToken() {
          return TOKEN;
        },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (
      init?.method === "DELETE" &&
      /\/model-profiles\/[0-9a-f-]+$/.test(url)
    ) {
      return new Response(null, { status: 204 });
    }
    const body = url.endsWith("/settings/status")
      ? status()
      : url.endsWith("/settings")
        ? settings()
        : url.endsWith("/model-profiles") && (init?.method ?? "GET") === "GET"
          ? [model()]
          : model();
    return new Response(JSON.stringify(body), {
      status:
        init?.method === "POST" && url.endsWith("/model-profiles") ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const credential = "test-only-credential-value";
  try {
    await getVeraModelSettingsStatus();
    await getVeraWorkspaceSettings();
    await patchVeraWorkspaceSettings({ theme: "dark" });
    await listVeraModelProfiles();
    await createVeraModelProfile({
      name: "主要 OpenAI",
      provider: "openai",
      model: "gpt-5.5",
      base_url: null,
    });
    await updateVeraModelProfile(PROFILE_ID, {
      model: "gpt-5.4",
      capabilities: {
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      },
    });
    await putVeraModelCredential(PROFILE_ID, credential);
    await deleteVeraModelCredential(PROFILE_ID);
    await testVeraModelProfile(PROFILE_ID);
    await enableVeraModelProfile(PROFILE_ID);
    await disableVeraModelProfile(PROFILE_ID);
    await setDefaultVeraModelProfile(PROFILE_ID);
    await deleteVeraModelProfile(PROFILE_ID);

    assert.deepEqual(
      calls.map((call) => [
        new URL(call.url).pathname.replace("/api/v1", ""),
        call.init?.method ?? "GET",
      ]),
      [
        ["/settings/status", "GET"],
        ["/settings", "GET"],
        ["/settings", "PATCH"],
        ["/model-profiles", "GET"],
        ["/model-profiles", "POST"],
        [`/model-profiles/${PROFILE_ID}`, "PATCH"],
        [`/model-profiles/${PROFILE_ID}/credential`, "PUT"],
        [`/model-profiles/${PROFILE_ID}/credential`, "DELETE"],
        [`/model-profiles/${PROFILE_ID}/test`, "POST"],
        [`/model-profiles/${PROFILE_ID}/enable`, "POST"],
        [`/model-profiles/${PROFILE_ID}/disable`, "POST"],
        [`/model-profiles/${PROFILE_ID}/default`, "POST"],
        [`/model-profiles/${PROFILE_ID}`, "DELETE"],
      ],
    );
    for (const call of calls) {
      assert.equal(
        new Headers(call.init?.headers).get("authorization"),
        `Bearer ${TOKEN}`,
      );
      assert.equal(call.url.includes(TOKEN), false);
    }
    assert.deepEqual(JSON.parse(String(calls[6]?.init?.body)), {
      secret: credential,
    });
    assert.deepEqual(JSON.parse(String(calls[5]?.init?.body)), {
      model: "gpt-5.4",
      capabilities: {
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      },
    });
    assert.equal(String(calls[6]?.url).includes(credential), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("settings mutations reject unexpected or ambiguous request fields before fetch", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch must not run");
  };
  try {
    await assert.rejects(
      patchVeraWorkspaceSettings({ secret: "no" } as never),
      /settings update is invalid/i,
    );
    await assert.rejects(createVeraModelProfile({}), /request is invalid/i);
    await assert.rejects(
      createVeraModelProfile({
        name: "name",
        provider: "openai_compatible",
        model: "model",
        base_url: "http://example.com/v1",
      }),
      /base URL is invalid/i,
    );
    await assert.rejects(
      updateVeraModelProfile(PROFILE_ID, { api_key: "no" } as never),
      /model profile request is invalid/i,
    );
    await assert.rejects(
      updateVeraModelProfile(PROFILE_ID, {
        capabilities: { streaming: true } as never,
      }),
      /model capabilities are invalid/i,
    );
    await assert.rejects(
      putVeraModelCredential(PROFILE_ID, "密".repeat(3_000)),
      /credential is invalid/i,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uncontrolled credential submission clears the field on success, failure, and validation", async () => {
  const successField = { value: "one-time-value" };
  let received = "";
  await submitVeraCredentialInput(successField, async (value) => {
    assert.equal(successField.value, "");
    received = value;
  });
  assert.equal(received, "one-time-value");
  assert.equal(successField.value, "");

  const failureField = { value: "one-time-failure" };
  await assert.rejects(
    submitVeraCredentialInput(failureField, async () => {
      throw new Error("store failed");
    }),
    /store failed/,
  );
  assert.equal(failureField.value, "");

  const invalidField = { value: "line\nbreak" };
  await assert.rejects(
    submitVeraCredentialInput(invalidField, async () => undefined),
    VeraCredentialInputError,
  );
  assert.equal(invalidField.value, "");
});

test("system theme applies persisted state and removes its media listener", () => {
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle(name: string, force?: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
        return Boolean(force);
      },
    },
    dataset: {} as DOMStringMap,
    style: { colorScheme: "" },
  };
  let listener: (() => void) | null = null;
  let removed: (() => void) | null = null;
  const media = {
    matches: true,
    addEventListener(event: string, next: () => void) {
      assert.equal(event, "change");
      listener = next;
    },
    removeEventListener(event: string, next: () => void) {
      assert.equal(event, "change");
      removed = next;
    },
  };
  assert.equal(VERA_SYSTEM_DARK_QUERY, "(prefers-color-scheme: dark)");
  const cleanup = installVeraTheme("system", { root, media });
  assert.equal(classes.has("dark"), true);
  assert.equal(root.dataset.veraTheme, "system");
  assert.equal(root.dataset.veraResolvedTheme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.ok(listener);
  cleanup();
  assert.equal(removed, listener);
});
