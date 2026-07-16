"use client";

import { use } from "react";
import { MatterDraftsView } from "@/app/components/projects/MatterDraftsView";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterDraftsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <MatterCapabilityBoundary capability="drafts">
      <MatterDraftsView projectId={id} />
    </MatterCapabilityBoundary>
  );
}
