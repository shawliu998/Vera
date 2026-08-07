-- Event text is the lawyer-editable timeline statement. It remains part of
-- the existing event-row object and must never be inferred from source quotes.

alter table public.tabular_review_rows
  add column if not exists event_text text;

-- Do not fabricate statements for any rows created outside the unapplied
-- migration chain. Stop with an actionable diagnostic so an operator can
-- supply explicit user-authored text before retrying.
do $$
begin
  if exists (
    select 1
    from public.tabular_review_rows
    where event_text is null
       or char_length(btrim(event_text)) not between 1 and 4000
  ) then
    raise exception
      'Cannot require tabular_review_rows.event_text: existing event rows need explicit 1-4000 character event text';
  end if;
end $$;

alter table public.tabular_review_rows
  alter column event_text set not null;

alter table public.tabular_review_rows
  drop constraint if exists tabular_review_rows_event_text_check;

alter table public.tabular_review_rows
  add constraint tabular_review_rows_event_text_check
  check (char_length(btrim(event_text)) between 1 and 4000);
