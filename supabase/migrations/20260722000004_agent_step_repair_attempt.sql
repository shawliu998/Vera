-- A verifier repair allowance belongs to its verifier step, not a mutable
-- checkpoint summary. Conditional updates reserve the single repair pass.

alter table public.agent_steps
  add column if not exists repair_attempt smallint not null default 0;

alter table public.agent_steps
  drop constraint if exists agent_steps_repair_attempt_check;

alter table public.agent_steps
  add constraint agent_steps_repair_attempt_check
  check (repair_attempt between 0 and 1);
