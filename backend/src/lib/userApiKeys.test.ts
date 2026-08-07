import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeApiKeyProvider } from "./userApiKeys";

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
