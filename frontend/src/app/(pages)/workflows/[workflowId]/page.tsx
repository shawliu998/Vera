"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/workflows/assistant/[id]/page.tsx and
// frontend/src/app/(pages)/workflows/tabular-review/[id]/page.tsx.

import { use } from "react";

import { VeraWorkflowEditor } from "@/app/components/workflows/VeraWorkflowEditor";

export default function VeraWorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = use(params);
  return <VeraWorkflowEditor workflowId={workflowId} />;
}
