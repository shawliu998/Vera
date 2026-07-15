"use client";

// Project-scoped entry point following Mike e32daad's generic Project
// container hierarchy. Workflow definitions remain reusable; the Project ID
// is carried only into the durable run configuration.

import { use } from "react";

import { ProjectSectionToolbar } from "@/app/components/projects/ProjectWorkspace";
import { VeraWorkflowList } from "@/app/components/workflows/VeraWorkflowList";

export default function ProjectWorkflowsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectSectionToolbar />
      <div className="min-h-0 flex-1 overflow-hidden">
        <VeraWorkflowList projectId={id} />
      </div>
    </div>
  );
}
