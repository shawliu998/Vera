-- Migration date: 2026-07-08

-- Aletheia agent runtime skeleton.
--
-- These tables model auditable agent workflow execution without committing the
-- product to a specific model provider, queue system, or storage backend.

create table if not exists public.aletheia_agent_runs (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  workflow text not null check (
    workflow in ('legal_matter_review', 'compliance_impact_review', 'deal_due_diligence')
  ),
  goal text not null,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'blocked', 'needs_human', 'completed', 'failed', 'cancelled')
  ),
  current_step_key text,
  model_profile text,
  storage_driver text not null default 'supabase' check (
    storage_driver in ('local', 'postgres', 'supabase')
  ),
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aletheia_agent_runs_matter_created
  on public.aletheia_agent_runs(matter_id, created_at desc);

create index if not exists idx_aletheia_agent_runs_user_status
  on public.aletheia_agent_runs(user_id, status, updated_at desc);

create table if not exists public.aletheia_agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.aletheia_agent_runs(id) on delete cascade,
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  step_key text not null,
  title text not null,
  sequence integer not null default 0,
  status text not null default 'pending' check (
    status in ('pending', 'running', 'completed', 'needs_human', 'failed', 'skipped')
  ),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_aletheia_agent_steps_run_sequence
  on public.aletheia_agent_steps(run_id, sequence);

create table if not exists public.aletheia_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.aletheia_agent_runs(id) on delete cascade,
  step_id uuid references public.aletheia_agent_steps(id) on delete set null,
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  tool_name text not null,
  risk_level text not null default 'medium' check (
    risk_level in ('low', 'medium', 'high')
  ),
  status text not null default 'pending' check (
    status in ('pending', 'running', 'completed', 'failed', 'requires_confirmation')
  ),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_aletheia_tool_calls_run_created
  on public.aletheia_tool_calls(run_id, created_at);

create table if not exists public.aletheia_human_checkpoints (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.aletheia_agent_runs(id) on delete cascade,
  step_id uuid references public.aletheia_agent_steps(id) on delete set null,
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  checkpoint_type text not null,
  status text not null default 'open' check (
    status in ('open', 'approved', 'rejected', 'resolved', 'cancelled')
  ),
  prompt text not null,
  decision text,
  requested_payload jsonb not null default '{}'::jsonb,
  decision_payload jsonb not null default '{}'::jsonb,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_aletheia_human_checkpoints_matter_status
  on public.aletheia_human_checkpoints(matter_id, status, created_at desc);

alter table public.aletheia_agent_runs enable row level security;
alter table public.aletheia_agent_steps enable row level security;
alter table public.aletheia_tool_calls enable row level security;
alter table public.aletheia_human_checkpoints enable row level security;

drop policy if exists aletheia_agent_runs_visible on public.aletheia_agent_runs;
create policy aletheia_agent_runs_visible
  on public.aletheia_agent_runs
  for select
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_agent_runs_owner_write on public.aletheia_agent_runs;
create policy aletheia_agent_runs_owner_write
  on public.aletheia_agent_runs
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_agent_steps_visible on public.aletheia_agent_steps;
create policy aletheia_agent_steps_visible
  on public.aletheia_agent_steps
  for select
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_agent_steps_owner_write on public.aletheia_agent_steps;
create policy aletheia_agent_steps_owner_write
  on public.aletheia_agent_steps
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_tool_calls_visible on public.aletheia_tool_calls;
create policy aletheia_tool_calls_visible
  on public.aletheia_tool_calls
  for select
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_tool_calls_owner_write on public.aletheia_tool_calls;
create policy aletheia_tool_calls_owner_write
  on public.aletheia_tool_calls
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_human_checkpoints_visible on public.aletheia_human_checkpoints;
create policy aletheia_human_checkpoints_visible
  on public.aletheia_human_checkpoints
  for select
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_human_checkpoints_owner_write on public.aletheia_human_checkpoints;
create policy aletheia_human_checkpoints_owner_write
  on public.aletheia_human_checkpoints
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

revoke all on public.aletheia_agent_runs from anon, authenticated;
revoke all on public.aletheia_agent_steps from anon, authenticated;
revoke all on public.aletheia_tool_calls from anon, authenticated;
revoke all on public.aletheia_human_checkpoints from anon, authenticated;
