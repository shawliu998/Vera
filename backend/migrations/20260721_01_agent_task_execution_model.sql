-- Persist the explicitly selected model on each Work Task. This prevents a
-- retry or application restart from silently changing model providers.

alter table public.agent_tasks
  add column if not exists execution_model text not null
  default 'gemini-3-flash-preview';

alter table public.agent_tasks
  drop constraint if exists agent_tasks_execution_model_nonempty;

alter table public.agent_tasks
  add constraint agent_tasks_execution_model_nonempty
  check (char_length(btrim(execution_model)) between 1 and 100);

alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'deepseek', 'openrouter', 'courtlistener'));
