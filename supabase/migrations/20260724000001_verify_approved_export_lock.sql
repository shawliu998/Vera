-- Migration date: 2026-07-24

-- Atomic authorization linearization point for final export.
-- Verifies, in one statement, that the task is still owned by the caller and
-- completed, the latest review decision is still the approved decision used for
-- export, that decision contains exactly one matching artifact snapshot row,
-- the document's current version is still the approved version, and the version
-- has not been soft-deleted.

create or replace function public.verify_approved_export_lock(
  p_task_id uuid,
  p_user_id text,
  p_decision_id uuid,
  p_document_id uuid,
  p_version_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_tasks t
    join public.agent_task_review_decisions d
      on d.task_id = t.id
    join public.documents doc
      on doc.id = p_document_id
    join public.document_versions v
      on v.id = p_version_id
      and v.document_id = doc.id
    where t.id = p_task_id
      and t.user_id = p_user_id
      and t.status = 'completed'
      and doc.project_id = t.matter_id
      and doc.user_id = t.user_id
      and d.id = p_decision_id
      and d.status = 'approved'
      and d.id = (
        select d2.id
        from public.agent_task_review_decisions d2
        where d2.task_id = t.id
        order by d2.created_at desc, d2.id desc
        limit 1
      )
      and 1 = (
        select count(*)
        from jsonb_array_elements(
          case
            when jsonb_typeof(d.artifact_snapshot) = 'array'
              then d.artifact_snapshot
            else '[]'::jsonb
          end
        ) as artifact(item)
        where artifact.item ->> 'artifact_id' = p_document_id::text
          and artifact.item ->> 'document_id' = p_document_id::text
          and artifact.item ->> 'version_id' = p_version_id::text
      )
      and doc.current_version_id = p_version_id
      and v.deleted_at is null
  );
$$;

revoke all on function public.verify_approved_export_lock(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.verify_approved_export_lock(uuid, text, uuid, uuid, uuid) to service_role;
