-- Provider source snapshots remain ordinary Matter DocumentVersions. Preserve
-- any earlier patent import rows while converging all legal and patent source
-- imports on one provenance field and one generic source value.

ALTER TABLE public.document_versions
  ADD COLUMN IF NOT EXISTS provider_source jsonb;

ALTER TABLE public.document_versions
  DROP CONSTRAINT IF EXISTS document_versions_source_check;

UPDATE public.document_versions
SET source = 'provider_import'
WHERE source = 'patent_provider_import';

ALTER TABLE public.document_versions
  ADD CONSTRAINT document_versions_source_check
  CHECK (
    source = ANY (
      ARRAY[
        'upload'::text,
        'user_upload'::text,
        'assistant_edit'::text,
        'user_accept'::text,
        'user_reject'::text,
        'generated'::text,
        'provider_import'::text
      ]
    )
  );

COMMENT ON COLUMN public.document_versions.provider_source IS
  'Validated body-free provenance for an immutable provider snapshot; source bytes remain in this DocumentVersion storage object.';
