-- Extend the exact deterministic Verifier issue contract with one
-- high-confidence abrupt-ending fact. This does not make the observation an
-- approval, export, or mutation decision; the application still binds any
-- bounded repair to the fixed current accepted-view hash and one Step attempt.

alter function public.agent_verifier_deterministic_issue_valid_v1(jsonb)
  rename to agent_verifier_deterministic_issue_valid_legacy_v1;

create or replace function public.agent_verifier_deterministic_issue_valid_v1(
  p_issue jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ending_excerpt text;
begin
  if jsonb_typeof(p_issue) is distinct from 'object'
    or jsonb_typeof(p_issue -> 'code') is distinct from 'string' then
    return false;
  end if;

  if p_issue ->> 'code' <> 'artifact_incomplete_ending' then
    return public.agent_verifier_deterministic_issue_valid_legacy_v1(
      p_issue
    );
  end if;

  if not (p_issue ?& array[
      'code', 'deliverable_key', 'document_id', 'version_id',
      'accepted_view_sha256', 'ending_excerpt'
    ])
    or p_issue - array[
      'code', 'deliverable_key', 'document_id', 'version_id',
      'accepted_view_sha256', 'ending_excerpt'
    ] <> '{}'::jsonb
    or jsonb_typeof(p_issue -> 'deliverable_key') is distinct from 'string'
    or length(trim(p_issue ->> 'deliverable_key')) not between 1 and 120
    or jsonb_typeof(p_issue -> 'document_id') is distinct from 'string'
    or p_issue ->> 'document_id'
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_issue -> 'version_id') is distinct from 'string'
    or p_issue ->> 'version_id'
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_issue -> 'accepted_view_sha256')
      is distinct from 'string'
    or p_issue ->> 'accepted_view_sha256'
      !~ '^sha256:[a-f0-9]{64}$'
    or jsonb_typeof(p_issue -> 'ending_excerpt') is distinct from 'string'
  then
    return false;
  end if;

  v_ending_excerpt := trim(p_issue ->> 'ending_excerpt');
  return length(v_ending_excerpt) between 40 and 500
    and (
      v_ending_excerpt ~ '(均明确标注为|明确标注为|列示为|说明为|载明为|表述为|认定为|界定为|定义为|称为|视为|包括|如下|下列|以及|并且|而且|或者|但是|即|例如)(：|:)?$'
      or v_ending_excerpt ~* '(^|[[:space:]])(including|as follows|such as|and|or|but|means|is|are|to|of|for|with|by)(：|:)?$'
    );
end;
$$;

revoke all on function public.agent_verifier_deterministic_issue_valid_v1(
  jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.agent_verifier_deterministic_issue_valid_legacy_v1(
  jsonb
) from public, anon, authenticated, service_role;

comment on function public.agent_verifier_deterministic_issue_valid_v1(
  jsonb
) is
  'Internal exact-schema validator for server-owned deterministic verifier issue facts, including a fixed current-Version abrupt-ending observation.';

comment on function public.agent_verifier_deterministic_issue_valid_legacy_v1(
  jsonb
) is
  'Private pre-migration validator retained only as the fail-closed legacy branch of agent_verifier_deterministic_issue_valid_v1.';
