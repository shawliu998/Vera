-- Allow a versioned EPO OPS consumer-key/consumer-secret envelope in the
-- existing encrypted per-user credential store. This adds no table, changes
-- no RLS policy, and does not expose either secret to browser reads.

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
      'zhipu',
      'epo_ops'
    )
  );
