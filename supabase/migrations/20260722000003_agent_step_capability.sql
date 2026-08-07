-- Persist the planner's typed capability on each Agent step. Existing steps
-- remain null and must be handled fail-closed; prose titles are not authority
-- to grant document mutation tools.

alter table public.agent_steps
  add column if not exists capability text;

alter table public.agent_steps
  drop constraint if exists agent_steps_capability_check;

alter table public.agent_steps
  add constraint agent_steps_capability_check
  check (
    capability is null
    or capability in (
      'read_sources',
      'analyze',
      'create_tabular',
      'create_draft',
      'verify'
    )
  );

