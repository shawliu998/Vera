-- Persist the machine-readable verifier receipt on the existing step row so
-- review/export can prove they are releasing the versions that were checked.

alter table public.agent_steps
  add column if not exists result_data jsonb;

alter table public.agent_steps
  drop constraint if exists agent_steps_result_data_check;

alter table public.agent_steps
  add constraint agent_steps_result_data_check
  check (result_data is null or jsonb_typeof(result_data) = 'object');

