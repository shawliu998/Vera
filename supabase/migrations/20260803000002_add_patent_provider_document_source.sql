-- Patent provider snapshots are ordinary Matter DocumentVersions. Extend the
-- existing source allowlist so imported, read-only patent records keep their
-- provenance without introducing a parallel patent document table.

ALTER TABLE public.document_versions
  DROP CONSTRAINT IF EXISTS document_versions_source_check;

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
        'patent_provider_import'::text
      ]
    )
  );
