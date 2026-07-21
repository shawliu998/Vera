"use client";

import { use } from "react";
import { WorkTasksTable } from "@/app/components/agent/WorkTasksOverview";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";

export default function ProjectWorkTasksPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    use(params);
    const { projectId, search } = useProjectWorkspace();
    return (
        <>
            <ProjectSectionToolbar />
            <WorkTasksTable
                matterId={projectId}
                search={search}
                showMatter={false}
            />
        </>
    );
}
