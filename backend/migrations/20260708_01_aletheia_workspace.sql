-- Migration date: 2026-07-08

-- Aletheia workspace domain model.
--
-- These tables intentionally sit beside the original project/chat/review
-- primitives. They model the product surface Aletheia needs for verifiable,
-- reviewable, and auditable professional workflows.

create table if not exists public.aletheia_matters (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null,
  template text not null check (
    template in ('legal_matter_review', 'compliance_impact_review', 'deal_due_diligence')
  ),
  status text not null default 'draft' check (
    status in ('draft', 'in_progress', 'needs_review', 'completed', 'archived')
  ),
  client_or_project text,
  objective text not null,
  risk_level text check (risk_level in ('low', 'medium', 'high')),
  source_project_id uuid references public.projects(id) on delete set null,
  shared_with jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aletheia_matters_user_updated
  on public.aletheia_matters(user_id, updated_at desc);

create index if not exists idx_aletheia_matters_template
  on public.aletheia_matters(template);

create index if not exists idx_aletheia_matters_shared_with
  on public.aletheia_matters using gin (shared_with);

create table if not exists public.aletheia_matter_documents (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  document_id uuid references public.documents(id) on delete set null,
  name text not null,
  document_type text not null default 'other',
  parsed_status text not null default 'pending' check (
    parsed_status in ('pending', 'parsed', 'failed')
  ),
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aletheia_matter_documents_matter
  on public.aletheia_matter_documents(matter_id);

create index if not exists idx_aletheia_matter_documents_user
  on public.aletheia_matter_documents(user_id);

create table if not exists public.aletheia_work_products (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  kind text not null check (
    kind in (
      'agent_plan',
      'chronology',
      'issue_map',
      'evidence_matrix',
      'draft_memo',
      'compliance_register',
      'red_flag_memo',
      'audit_pack',
      'feedback_export'
    )
  ),
  title text not null,
  status text not null default 'draft' check (
    status in ('draft', 'generated', 'needs_review', 'accepted', 'superseded')
  ),
  schema_version text not null default 'aletheia-v0',
  content jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  generated_by text not null default 'system' check (
    generated_by in ('system', 'agent', 'human')
  ),
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aletheia_work_products_matter_kind
  on public.aletheia_work_products(matter_id, kind);

create index if not exists idx_aletheia_work_products_user_updated
  on public.aletheia_work_products(user_id, updated_at desc);

create table if not exists public.aletheia_evidence_items (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  work_product_id uuid references public.aletheia_work_products(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  claim_id text,
  document_name text,
  page integer,
  section text,
  quote text not null,
  relevance text not null default 'direct' check (
    relevance in ('direct', 'indirect', 'weak')
  ),
  support_status text not null default 'insufficient' check (
    support_status in ('supports', 'contradicts', 'insufficient')
  ),
  confidence text check (confidence in ('low', 'medium', 'high')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_aletheia_evidence_items_matter
  on public.aletheia_evidence_items(matter_id);

create index if not exists idx_aletheia_evidence_items_claim
  on public.aletheia_evidence_items(matter_id, claim_id);

create table if not exists public.aletheia_review_items (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  work_product_id uuid references public.aletheia_work_products(id) on delete set null,
  evidence_item_id uuid references public.aletheia_evidence_items(id) on delete set null,
  target_type text not null check (
    target_type in ('claim', 'evidence', 'memo_section', 'work_product', 'matter')
  ),
  target_id text not null,
  tag text not null check (
    tag in (
      'unsupported_claim',
      'citation_not_supporting',
      'missing_fact',
      'overclaim',
      'outdated_authority',
      'conflicting_evidence',
      'needs_human_judgment',
      'accepted',
      'rejected'
    )
  ),
  comment text not null,
  reviewer_user_id text,
  reviewer_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_aletheia_review_items_matter_created
  on public.aletheia_review_items(matter_id, created_at desc);

create index if not exists idx_aletheia_review_items_tag
  on public.aletheia_review_items(tag);

create table if not exists public.aletheia_audit_events (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text,
  actor text not null check (actor in ('system', 'agent', 'human')),
  action text not null,
  workflow_version text,
  model text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_aletheia_audit_events_matter_created
  on public.aletheia_audit_events(matter_id, created_at desc);

create index if not exists idx_aletheia_audit_events_action
  on public.aletheia_audit_events(action);

alter table public.aletheia_matters enable row level security;
alter table public.aletheia_matter_documents enable row level security;
alter table public.aletheia_work_products enable row level security;
alter table public.aletheia_evidence_items enable row level security;
alter table public.aletheia_review_items enable row level security;
alter table public.aletheia_audit_events enable row level security;

drop policy if exists aletheia_matters_owner_select on public.aletheia_matters;
create policy aletheia_matters_owner_select
  on public.aletheia_matters
  for select
  using (
    user_id = auth.uid()::text
    or shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
  );

drop policy if exists aletheia_matters_owner_write on public.aletheia_matters;
create policy aletheia_matters_owner_write
  on public.aletheia_matters
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_matter_documents_visible on public.aletheia_matter_documents;
create policy aletheia_matter_documents_visible
  on public.aletheia_matter_documents
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

drop policy if exists aletheia_matter_documents_owner_write on public.aletheia_matter_documents;
create policy aletheia_matter_documents_owner_write
  on public.aletheia_matter_documents
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_work_products_visible on public.aletheia_work_products;
create policy aletheia_work_products_visible
  on public.aletheia_work_products
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

drop policy if exists aletheia_work_products_owner_write on public.aletheia_work_products;
create policy aletheia_work_products_owner_write
  on public.aletheia_work_products
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_evidence_items_visible on public.aletheia_evidence_items;
create policy aletheia_evidence_items_visible
  on public.aletheia_evidence_items
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

drop policy if exists aletheia_evidence_items_owner_write on public.aletheia_evidence_items;
create policy aletheia_evidence_items_owner_write
  on public.aletheia_evidence_items
  for all
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and m.user_id = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and m.user_id = auth.uid()::text
    )
  );

drop policy if exists aletheia_review_items_visible on public.aletheia_review_items;
create policy aletheia_review_items_visible
  on public.aletheia_review_items
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

drop policy if exists aletheia_review_items_owner_write on public.aletheia_review_items;
create policy aletheia_review_items_owner_write
  on public.aletheia_review_items
  for all
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and m.user_id = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and m.user_id = auth.uid()::text
    )
  );

drop policy if exists aletheia_audit_events_visible on public.aletheia_audit_events;
create policy aletheia_audit_events_visible
  on public.aletheia_audit_events
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

drop policy if exists aletheia_audit_events_owner_insert on public.aletheia_audit_events;
create policy aletheia_audit_events_owner_insert
  on public.aletheia_audit_events
  for insert
  with check (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and m.user_id = auth.uid()::text
    )
  );

create or replace function public.get_aletheia_matters_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  title text,
  template text,
  status text,
  client_or_project text,
  objective text,
  risk_level text,
  created_at timestamptz,
  updated_at timestamptz,
  document_count integer,
  evidence_count integer,
  review_count integer,
  audit_event_count integer,
  latest_audit_at timestamptz
)
language sql
stable
as $$
  with visible_matters as (
    select m.*
    from public.aletheia_matters m
    where m.user_id = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and m.user_id <> p_user_id
        and m.shared_with @> jsonb_build_array(p_user_email)
      )
  ),
  document_counts as (
    select matter_id, count(*)::integer as document_count
    from public.aletheia_matter_documents
    where matter_id in (select id from visible_matters)
    group by matter_id
  ),
  evidence_counts as (
    select matter_id, count(*)::integer as evidence_count
    from public.aletheia_evidence_items
    where matter_id in (select id from visible_matters)
    group by matter_id
  ),
  review_counts as (
    select matter_id, count(*)::integer as review_count
    from public.aletheia_review_items
    where matter_id in (select id from visible_matters)
    group by matter_id
  ),
  audit_counts as (
    select
      matter_id,
      count(*)::integer as audit_event_count,
      max(created_at) as latest_audit_at
    from public.aletheia_audit_events
    where matter_id in (select id from visible_matters)
    group by matter_id
  )
  select
    vm.id,
    vm.user_id,
    vm.title,
    vm.template,
    vm.status,
    vm.client_or_project,
    vm.objective,
    vm.risk_level,
    vm.created_at,
    vm.updated_at,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(ec.evidence_count, 0) as evidence_count,
    coalesce(rc.review_count, 0) as review_count,
    coalesce(ac.audit_event_count, 0) as audit_event_count,
    ac.latest_audit_at
  from visible_matters vm
  left join document_counts dc on dc.matter_id = vm.id
  left join evidence_counts ec on ec.matter_id = vm.id
  left join review_counts rc on rc.matter_id = vm.id
  left join audit_counts ac on ac.matter_id = vm.id
  order by vm.updated_at desc;
$$;
