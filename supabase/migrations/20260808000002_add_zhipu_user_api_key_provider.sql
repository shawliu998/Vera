-- Allow Zhipu GLM credentials in the existing encrypted per-user API-key
-- store. This changes only the provider allowlist; it does not add a table,
-- change RLS, or expose key material to browser clients.

ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (
    provider IN (
      'claude',
      'gemini',
      'openai',
      'deepseek',
      'kimi',
      'openrouter',
      'courtlistener',
      'patsnap',
      'zhipu'
    )
  );
