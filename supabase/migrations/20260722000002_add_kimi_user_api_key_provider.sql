-- Allow Kimi API keys in the existing encrypted per-user provider store.
-- This expands only the existing provider enum; it does not add a table,
-- change RLS, or expose key material to browser clients.

ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('claude', 'gemini', 'openai', 'deepseek', 'kimi', 'openrouter', 'courtlistener'));
