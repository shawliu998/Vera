"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/workflows/assistant/[id]/page.tsx and
// frontend/src/app/(pages)/workflows/tabular-review/[id]/page.tsx.

import { use } from "react";

import { VeraWorkflowEditor } from "@/app/components/workflows/VeraWorkflowEditor";

export default function VeraWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>;
  searchParams: Promise<{ project_id?: string | string[] }>;
}) {
  const { workflowId } = use(params);
  const query = use(searchParams);
  const initialProjectId =
    typeof query.project_id === "string" ? query.project_id : null;
  return (
    <VeraWorkflowEditor
      workflowId={workflowId}
      initialProjectId={initialProjectId}
    />
  );
}
