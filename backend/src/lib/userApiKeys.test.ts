import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getUserApiKeys,
  getUserEpoOpsCredentials,
  getUserEpoOpsCredentialStatus,
  normalizeApiKeyProvider,
  saveUserEpoOpsCredentials,
} from "./userApiKeys";

type StoredRow = {
  user_id: string;
  provider: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  updated_at: string;
};

function inMemoryCredentialDb() {
  const rows = new Map<string, StoredRow>();
  const key = (userId: string, provider: string) => `${userId}\0${provider}`;
  return {
    rows,
    client: {
      from(table: string) {
        assert.equal(table, "user_api_keys");
        let mode: "select" | "delete" = "select";
        const filters = new Map<string, string>();
        const result = () => {
          const matches = [...rows.values()].filter((row) =>
            [...filters.entries()].every(
              ([field, value]) =>
                String(row[field as keyof StoredRow]) === value,
            ),
          );
          if (mode === "delete") {
            for (const row of matches)
              rows.delete(key(row.user_id, row.provider));
            return { data: null, error: null };
          }
          return { data: matches, error: null };
        };
        const builder = {
          select() {
            mode = "select";
            return builder;
          },
          delete() {
            mode = "delete";
            return builder;
          },
          eq(field: string, value: string) {
            filters.set(field, value);
            return builder;
          },
          maybeSingle() {
            const selected = result();
            const data = Array.isArray(selected.data)
              ? (selected.data[0] ?? null)
              : null;
            return Promise.resolve({ data, error: null });
          },
          upsert(value: StoredRow) {
            rows.set(key(value.user_id, value.provider), value);
            return Promise.resolve({ data: null, error: null });
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve(result()).then(resolve);
          },
        };
        return builder;
      },
    },
  };
}

test("recognizes Zhipu as an existing encrypted API-key provider", () => {
  assert.equal(normalizeApiKeyProvider("zhipu"), "zhipu");
  assert.equal(normalizeApiKeyProvider("Zhipu"), null);
});

test("keeps Zhipu provider migrations mirrored and preserves prior providers", async () => {
  const backend = await readFile(
    new URL(
      "../../migrations/20260808_02_add_zhipu_user_api_key_provider.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000002_add_zhipu_user_api_key_provider.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(backend, supabase);
  for (const provider of [
    "claude",
    "gemini",
    "openai",
    "deepseek",
    "kimi",
    "openrouter",
    "courtlistener",
    "patsnap",
    "zhipu",
  ]) {
    assert.match(backend, new RegExp(`'${provider}'`));
  }
  assert.doesNotMatch(backend, /encrypted_key|auth_tag|\biv\b/i);
});

test("stores one encrypted EPO OPS pair per user without widening generic API keys", async () => {
  const previousSecret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
  const previousKey = process.env.EPO_OPS_CONSUMER_KEY;
  const previousConsumerSecret = process.env.EPO_OPS_CONSUMER_SECRET;
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-encryption-secret";
  delete process.env.EPO_OPS_CONSUMER_KEY;
  delete process.env.EPO_OPS_CONSUMER_SECRET;
  const memory = inMemoryCredentialDb();
  const db = memory.client as never;
  try {
    await saveUserEpoOpsCredentials(
      "user-a",
      { consumerKey: "key-a", consumerSecret: "secret-a" },
      db,
    );
    const raw = memory.rows.get("user-a\0epo_ops");
    assert.ok(raw);
    assert.doesNotMatch(raw.encrypted_key, /key-a|secret-a/);
    assert.deepEqual(await getUserEpoOpsCredentials("user-a", db), {
      consumerKey: "key-a",
      consumerSecret: "secret-a",
    });
    assert.equal(await getUserEpoOpsCredentials("user-b", db), null);
    assert.deepEqual(await getUserEpoOpsCredentialStatus("user-a", db), {
      configured: true,
      source: "user",
    });
    assert.deepEqual(await getUserEpoOpsCredentialStatus("user-b", db), {
      configured: false,
      source: null,
    });
    const genericKeys = await getUserApiKeys("user-a", db);
    assert.equal(Object.hasOwn(genericKeys, "epo_ops"), false);

    await saveUserEpoOpsCredentials(
      "user-b",
      { consumerKey: "key-b", consumerSecret: "secret-b" },
      db,
    );
    await saveUserEpoOpsCredentials("user-a", null, db);
    assert.equal(await getUserEpoOpsCredentials("user-a", db), null);
    assert.deepEqual(await getUserEpoOpsCredentials("user-b", db), {
      consumerKey: "key-b",
      consumerSecret: "secret-b",
    });
  } finally {
    if (previousSecret === undefined)
      delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    else process.env.USER_API_KEYS_ENCRYPTION_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.EPO_OPS_CONSUMER_KEY;
    else process.env.EPO_OPS_CONSUMER_KEY = previousKey;
    if (previousConsumerSecret === undefined)
      delete process.env.EPO_OPS_CONSUMER_SECRET;
    else process.env.EPO_OPS_CONSUMER_SECRET = previousConsumerSecret;
  }
});

test("uses a complete server EPO OPS pair without reading another user's row", async () => {
  const previousKey = process.env.EPO_OPS_CONSUMER_KEY;
  const previousSecret = process.env.EPO_OPS_CONSUMER_SECRET;
  process.env.EPO_OPS_CONSUMER_KEY = "env-key";
  process.env.EPO_OPS_CONSUMER_SECRET = "env-secret";
  const db = {
    from() {
      throw new Error("environment credentials must not query user rows");
    },
  } as never;
  try {
    assert.deepEqual(await getUserEpoOpsCredentials("any-user", db), {
      consumerKey: "env-key",
      consumerSecret: "env-secret",
    });
    assert.deepEqual(await getUserEpoOpsCredentialStatus("any-user", db), {
      configured: true,
      source: "env",
    });
  } finally {
    if (previousKey === undefined) delete process.env.EPO_OPS_CONSUMER_KEY;
    else process.env.EPO_OPS_CONSUMER_KEY = previousKey;
    if (previousSecret === undefined)
      delete process.env.EPO_OPS_CONSUMER_SECRET;
    else process.env.EPO_OPS_CONSUMER_SECRET = previousSecret;
  }
});

test("keeps the EPO OPS provider migration mirrored and preserves all providers", async () => {
  const backend = await readFile(
    new URL(
      "../../migrations/20260808_05_add_epo_ops_user_credentials.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000005_add_epo_ops_user_credentials.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  for (const provider of [
    "claude",
    "gemini",
    "openai",
    "deepseek",
    "kimi",
    "openrouter",
    "courtlistener",
    "patsnap",
    "zhipu",
    "epo_ops",
  ]) {
    assert.match(backend, new RegExp(`'${provider}'`));
  }
  assert.doesNotMatch(backend, /encrypted_key|auth_tag|\biv\b/i);
});
