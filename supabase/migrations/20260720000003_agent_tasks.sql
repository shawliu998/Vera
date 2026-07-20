-- Thin legal Agent task kernel. Existing chats, documents, workflows, drafts,
-- citations, and tabular reviews remain the system-of-record artifacts.

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  matter_id uuid not null references public.projects(id) on delete cascade,
  goal text not null check (char_length(btrim(goal)) between 1 and 4000),
  mode text not null default 'work' check (mode in ('ask', 'work')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_input', 'verifying', 'paused', 'completed', 'failed')),
  deliverables jsonb not null default '[]'::jsonb,
  current_step uuid,
  latest_checkpoint jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_tasks_user_updated_idx
  on public.agent_tasks(user_id, updated_at desc);

create index if not exists agent_tasks_matter_updated_idx
  on public.agent_tasks(matter_id, updated_at desc);

create table if not exists public.agent_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  position integer not null check (position >= 0),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'blocked', 'skipped')),
  expected_output text not null default '',
  attempt integer not null default 0 check (attempt >= 0),
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(task_id, position)
);

create index if not exists agent_steps_task_position_idx
  on public.agent_steps(task_id, position);

create table if not exists public.agent_artifact_links (
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  artifact_type text not null
    check (artifact_type in ('chat', 'document', 'draft', 'workflow_run', 'citation_snapshot', 'tabular_review')),
  artifact_id text not null,
  purpose text not null check (char_length(btrim(purpose)) between 1 and 300),
  created_at timestamptz not null default now(),
  primary key (task_id, artifact_type, artifact_id)
);

create index if not exists agent_artifact_links_artifact_idx
  on public.agent_artifact_links(artifact_type, artifact_id);

alter table public.agent_tasks enable row level security;
alter table public.agent_steps enable row level security;
alter table public.agent_artifact_links enable row level security;

revoke all on public.agent_tasks from anon, authenticated;
revoke all on public.agent_steps from anon, authenticated;
revoke all on public.agent_artifact_links from anon, authenticated;

grant all privileges on public.agent_tasks to service_role;
grant all privileges on public.agent_steps to service_role;
grant all privileges on public.agent_artifact_links to service_role;
